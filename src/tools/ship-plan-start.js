/**
 * ship_plan_start tool.
 *
 * Controller-only: runs stack skill sync, creates a workflow record,
 * issues the controller session lease, and dispatches the configured
 * planner child session via the real OpenCode dispatcher. The
 * workflow id is derived from the issue number so resume can locate it.
 * Skill discovery is inside this tool so it cannot be skipped.
 *
 * Authorization: the ToolContext session id is recorded as the
 * controller lease. Any later controller tool call must run from
 * the same lease-holding session; a fresh ship-controller session
 * takes over the lease atomically via `withControllerLease`.
 */

import { success, failure } from "./envelope.js";
import { resolveModelRoles } from "../installer/engineering-config.js";
import { isSetupComplete, readLock } from "../installer/lock.js";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { resolveGitCommonDir, opencodeShipStateDir } from "../state/git-common-dir.js";
import { dispatchWorker, issueControllerLease, ROLES } from "../runtime/opencode-dispatcher.js";
import { listManifests, writeManifest } from "../state/manifest-store.js";
import { nextLine, progressLine } from "../runtime/stages.js";

function normalizeWorkflowId(issueNumber) {
  return `wf-${issueNumber}`;
}

export function createPlanStartTool(deps) {
  return async function planStart(input) {
    const opId = input.operationId ?? `plan-start-${Date.now().toString(36)}`;
    const issueNumber = Number(input.issueNumber);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      return failure("plan-start", "issueNumber required", { operationId: opId, retryable: false });
    }
    const ctx = input.ctx ?? deps.ctx ?? null;
    if (!ctx || typeof ctx.sessionID !== "string" || ctx.agent !== "ship-controller") {
      return failure("plan-start", "ToolContext.sessionID required (controller session)", { operationId: opId, retryable: false });
    }
    const lock = await readLock(deps.repoRoot);
    if (!isSetupComplete(lock)) {
      return failure("plan-start", "setup is not complete; run /setup-ship-workflow first", { operationId: opId, retryable: false });
    }
    let models;
    try {
      models = resolveModelRoles(deps.config?.workflow, { strict: true });
    } catch (err) {
      return failure("plan-start", `model roles unresolved: ${err?.message ?? err}`, { operationId: opId, retryable: false });
    }
    const workflowId = normalizeWorkflowId(issueNumber);
    const repoRoot = deps.repoRoot;
    // Pull the real issue title and body via `gh issue view` so
    // the stack-skill discovery sees the user's actual request
    // (and any inline plan path) instead of the literal "issue #N".
    // The lookup is optional: if the driver is unavailable we
    // fall back to the literal so the controller does not refuse
    // to dispatch when offline.
    let issueText = `issue #${issueNumber}`;
    try {
      const readIssue = deps.readIssue ?? deps.driver?.readIssue;
      if (typeof readIssue === "function" && deps.repoSlug) {
        const issue = await readIssue({ repo: deps.repoSlug, number: issueNumber });
        const title = typeof issue?.title === "string" ? issue.title : "";
        const body = typeof issue?.body === "string" ? issue.body : "";
        const combined = [title, body].filter(Boolean).join("\n").trim();
        if (combined.length > 0) issueText = combined;
      }
    } catch {
      // Issue read is best-effort: the literal fallback keeps the
      // controller from refusing to dispatch when gh is offline.
    }
    let skills = { installed: [], skippedUntrusted: [], skippedPolicy: [], registryUnavailable: false, errors: [] };
    try {
      const syncFn = deps.syncSkills ?? (await import("../skills/sync.js")).syncSkills;
      skills = await syncFn({
        repoRoot,
        mode: "deliver",
        issueText,
        installFn: async (input) => {
          const { createSkillInstallTool } = await import("./ship-skill-install.js");
          const tool = createSkillInstallTool(deps);
          return tool(input);
        },
      });
    } catch (err) {
      skills = {
        installed: [],
        skippedUntrusted: [],
        skippedPolicy: [],
        registryUnavailable: true,
        errors: [String(err?.message ?? err)],
      };
    }
    try {
      const commonDir = await resolveGitCommonDir(repoRoot);
      const wfDir = join(opencodeShipStateDir(commonDir), "plans", workflowId);
      await mkdir(wfDir, { recursive: true });
      await issueControllerLease(repoRoot, workflowId, ctx.sessionID);
      const matchingManifests = (await listManifests(repoRoot)).filter((manifest) => manifest.issueNumber === issueNumber);
      if (matchingManifests.length > 1) {
        throw new Error(`multiple delivery manifests are linked to issue #${issueNumber}`);
      }
      if (matchingManifests.length === 1) {
        const manifest = matchingManifests[0];
        if (manifest.workflowId && manifest.workflowId !== workflowId) {
          throw new Error(`delivery manifest ${manifest.taskId} is already linked to ${manifest.workflowId}`);
        }
        await writeManifest(repoRoot, { ...manifest, workflowId, updatedAt: new Date().toISOString() });
      }
      const client = deps.opencodeClient;
      let dispatchResult = null;
      if (client) {
        dispatchResult = await dispatchWorker({
          repoRoot,
          workflowId,
          role: ROLES.PLANNER,
          keyInput: { revision: 1 },
          payload: { promptText: `Plan issue #${issueNumber}` },
          client,
          parentSessionID: ctx.sessionID,
          titleMarker: `ship-planner-${workflowId}`,
          agent: "ship-planner",
          model: models.planner,
        });
      }
      const indexRecord = {
        workflowId,
        issueNumber,
        owner: deps.owner,
        planner: models.planner,
        builder: models.builder,
        finalReviewer: models.finalReviewer,
        controllerSessionID: ctx.sessionID,
        plannerSessionID: dispatchResult?.sessionID ?? null,
        dispatchKey: dispatchResult?.dispatchKey ?? null,
        createdAt: new Date().toISOString(),
        state: "drafting",
      };
      await writeFile(join(wfDir, "index.json"), JSON.stringify(indexRecord, null, 2), "utf8");
      const stage = "plan";
      return success("plan-start", {
        workflowId,
        issueNumber,
        controllerSessionID: ctx.sessionID,
        plannerSessionID: indexRecord.plannerSessionID,
        dispatchKey: indexRecord.dispatchKey,
        models: {
          planner: models.planner,
          builder: models.builder,
          finalReviewer: models.finalReviewer,
        },
        skills,
        progress: progressLine(stage, { path: `wf-${issueNumber}` }),
        next: nextLine(stage),
      }, { operationId: opId });
    } catch (err) {
      return failure("plan-start", String(err?.message ?? err), { operationId: opId, retryable: true });
    }
  };
}
