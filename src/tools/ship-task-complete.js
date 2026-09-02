/**
 * ship_task_complete tool.
 *
 * Marks the active task as complete and either dispatches the
 * next task (`moreTasks: true`) or advances the run into
 * ALL_TASKS_DONE so the final review can begin.
 *
 * The reducer will refuse to advance the state if the task
 * was not in the committed state. The caller must pass an
 * explicit `nextTaskId` when `moreTasks: true` so resume can
 * recover the workflow.
 */
import { success, failure } from "./envelope.js";
import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { resolveGitCommonDir, opencodeShipStateDir } from "../state/git-common-dir.js";
import { publishImmutableJson } from "../state/durable-store.js";
import { appendRunEvent, readRunState, RUN_EVENT_KINDS } from "../workflow/run-controller.js";
import { readLock, isSetupComplete } from "../installer/lock.js";
import { authorizeControllerCall, dispatchWorker, ROLES } from "../runtime/opencode-dispatcher.js";
import { resolveModelRoles } from "../installer/engineering-config.js";
import { readPlanRevision } from "../workflow/plan-store.js";
import { buildFinalReviewPackage } from "../workflow/final-review.js";
import { listManifests } from "../state/manifest-store.js";
import { bucketFor } from "../gates.js";
import { publishGateReceipt, readGateReceipt } from "../workflow/gate-receipts.js";
import { resolveWorkflowWorktree } from "../workflow/worktree-resolver.js";
import { nextLine, progressLine } from "../runtime/stages.js";

const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function createTaskCompleteTool(deps) {
  return async function taskComplete(input) {
    const opId = input.operationId ?? `task-complete-${Date.now().toString(36)}`;
    const workflowId = String(input.workflowId ?? "");
    const taskId = String(input.taskId ?? "");
    const moreTasks = input.moreTasks === false ? false : input.moreTasks === true ? true : null;
    const nextTaskId = input.nextTaskId ? String(input.nextTaskId) : null;
    const expectedHead = String(input.expectedHead ?? "");
    if (!workflowId || !SAFE_ID_RE.test(workflowId)) {
      return failure("task-complete", "workflowId required (safe id)", { operationId: opId, retryable: false });
    }
    if (!taskId || !SAFE_ID_RE.test(taskId)) {
      return failure("task-complete", "taskId required (safe id)", { operationId: opId, retryable: false });
    }
    if (moreTasks === null) {
      return failure("task-complete", "moreTasks must be explicitly true or false", { operationId: opId, retryable: false });
    }
    if (moreTasks && (!nextTaskId || !SAFE_ID_RE.test(nextTaskId))) {
      return failure("task-complete", "nextTaskId required when moreTasks=true", { operationId: opId, retryable: false });
    }
    if (!moreTasks && !/^[0-9a-f]{40}$/.test(expectedHead)) {
      return failure("task-complete", "expectedHead required for final review", { operationId: opId, retryable: false });
    }
    const ctx = input.ctx ?? deps.ctx ?? null;
    const auth = await authorizeControllerCall(deps.repoRoot, workflowId, ctx);
    if (!auth.ok) {
      return failure("task-complete", `controller authorization failed: ${auth.message}`, { operationId: opId, retryable: false });
    }
    const lock = await readLock(deps.repoRoot);
    if (!isSetupComplete(lock)) {
      return failure("task-complete", "setup is not complete; run /setup-ship-workflow first", { operationId: opId, retryable: false });
    }
    let runState;
    try {
      runState = await readRunState(deps.repoRoot, workflowId);
    } catch (err) {
      return failure("task-complete", `run state unreadable: ${err?.message ?? err}`, { operationId: opId, retryable: false });
    }
    if (!runState) {
      return failure("task-complete", "run not started", { operationId: opId, retryable: false });
    }
    const priorComplete = runState.events.find((event) => (
      event.kind === RUN_EVENT_KINDS.TASK_COMPLETE
      && event.data?.taskId === taskId
      && event.data?.moreTasks === moreTasks
      && (event.data?.nextTaskId ?? null) === (nextTaskId ?? null)
    ));
    if (!priorComplete && runState.state !== "committed") {
      return failure("task-complete", `task-commit must precede task-complete; run state=${runState.state}`, { operationId: opId, retryable: false });
    }
    const planRecord = await readPlanRevision(deps.repoRoot, workflowId, runState.revision);
    if (!planRecord || planRecord.hash !== runState.sha256) {
      return failure("task-complete", "approved plan is missing or does not match the run", { operationId: opId, retryable: false });
    }
    if (!planRecord.plan.tasks.some((task) => task.id === taskId) || !runState.completedTasks.includes(taskId)) {
      return failure("task-complete", `task ${taskId} is not a committed task in the approved plan`, { operationId: opId, retryable: false });
    }
    const remainingTasks = planRecord.plan.tasks.filter((task) => !runState.completedTasks.includes(task.id));
    if (moreTasks && remainingTasks[0]?.id !== nextTaskId) {
      return failure("task-complete", `nextTaskId must be ${remainingTasks[0]?.id ?? "absent"}`, { operationId: opId, retryable: false });
    }
    if (!moreTasks && remainingTasks.length > 0) {
      return failure("task-complete", `plan still has incomplete tasks: ${remainingTasks.map((task) => task.id).join(", ")}`, { operationId: opId, retryable: false });
    }
    try {
      const resolved = await resolveWorkflowWorktree(deps.repoRoot, workflowId);
      if (!resolved.ok) {
        return failure("task-complete", `workflow worktree resolution failed: ${resolved.kind}`, {
          operationId: opId,
          retryable: false,
          details: resolved,
        });
      }
      const gateEvidence = moreTasks ? null : await loadTrustedGateEvidence({
        repoRoot: deps.repoRoot,
        repoSlug: deps.repoSlug,
        driver: deps.driver,
        adapter: deps.adapter,
        workflowId,
        issueNumber: planRecord.plan.source.issueNumber,
        expectedHead,
      });
      const commonDir = await resolveGitCommonDir(deps.repoRoot);
      const finalPackage = moreTasks ? null : await loadOrBuildFinalPackage({
        repoRoot: resolved.worktreePath,
        commonDir,
        workflowId,
        runState,
        planRecord,
        expectedHead,
        verificationHash: gateEvidence?.verificationHash ?? "",
        ciHash: gateEvidence?.ciHash ?? "",
        gateTaskId: gateEvidence?.taskId ?? "",
      });
      const completeDir = join(opencodeShipStateDir(commonDir), "runs", workflowId, "tasks", taskId, "complete");
      await mkdir(completeDir, { recursive: true });
      const record = {
        workflowId,
        taskId,
        moreTasks,
        nextTaskId: nextTaskId ?? null,
        finalReview: finalPackage,
        completedAt: new Date().toISOString(),
      };
      const completePath = join(completeDir, "complete.json");
      if (existsSync(completePath)) {
        const existing = JSON.parse(await readFile(completePath, "utf8"));
        if (
          existing.workflowId !== workflowId
          || existing.taskId !== taskId
          || existing.moreTasks !== moreTasks
          || (existing.nextTaskId ?? null) !== (nextTaskId ?? null)
          || (existing.finalReview?.packageHash ?? null) !== (finalPackage?.packageHash ?? null)
        ) {
          return failure("task-complete", "immutable task completion conflicts with retry", { operationId: opId, retryable: false });
        }
      } else {
        await publishImmutableJson(completePath, record);
      }
      let state = runState;
      let event = priorComplete ?? runState.events.at(-1);
      if (!priorComplete) {
        ({ state, event } = await appendRunEvent(
          deps.repoRoot,
          workflowId,
          runState,
          { kind: RUN_EVENT_KINDS.TASK_COMPLETE, data: { taskId, moreTasks, nextTaskId: nextTaskId ?? null } },
        ));
      }
      let finalReview = finalPackage ? {
        packageHash: finalPackage.packageHash,
        headSha: finalPackage.headSha,
        mergeBaseSha: finalPackage.mergeBaseSha,
        standardsSessionID: null,
        specSessionID: null,
      } : null;
      if (!moreTasks && deps.opencodeClient) {
        const models = resolveModelRoles(deps.config?.workflow, { strict: true });
        const packageHash = finalPackage.packageHash;
        const packagePath = join(opencodeShipStateDir(commonDir), "runs", workflowId, "final-review", "package.json");
        const promptText = [
          `Review workflow ${workflowId} package ${packageHash} at HEAD ${finalPackage.headSha} against merge base ${finalPackage.mergeBaseSha}.`,
          `Canonical package path: ${packagePath}`,
          `Canonical package:\n${JSON.stringify(finalPackage, null, 2)}`,
        ].join("\n\n");
        const [standards, spec] = await Promise.all([
          dispatchWorker({
            repoRoot: resolved.worktreePath,
            workflowId,
            role: ROLES.FINAL_STANDARDS,
            keyInput: { packageHash },
            payload: { promptText },
            client: deps.opencodeClient,
            parentSessionID: auth.sessionID,
            titleMarker: `ship-final-standards-${workflowId}`,
            agent: "ship-final-standards-reviewer",
            model: models.finalReviewer,
          }),
          dispatchWorker({
            repoRoot: resolved.worktreePath,
            workflowId,
            role: ROLES.FINAL_SPEC,
            keyInput: { packageHash },
            payload: { promptText },
            client: deps.opencodeClient,
            parentSessionID: auth.sessionID,
            titleMarker: `ship-final-spec-${workflowId}`,
            agent: "ship-final-spec-reviewer",
            model: models.finalReviewer,
          }),
        ]);
        finalReview = {
          packageHash,
          headSha: finalPackage.headSha,
          mergeBaseSha: finalPackage.mergeBaseSha,
          standardsSessionID: standards.sessionID,
          specSessionID: spec.sessionID,
        };
      }
      return success("task-complete", {
        workflowId,
        taskId,
        moreTasks,
        nextTaskId: nextTaskId ?? null,
        finalReview,
        state: state.state,
        sequence: event.sequence,
        progress: progressLine("verify", { ok: true }),
        next: nextLine("verify"),
      }, { operationId: opId });
    } catch (err) {
      return failure("task-complete", String(err?.message ?? err), { operationId: opId, retryable: true });
    }
  };
}

async function loadTrustedGateEvidence({ repoRoot, repoSlug, driver, adapter, workflowId, issueNumber, expectedHead }) {
  const manifests = (await listManifests(repoRoot)).filter((manifest) => manifest.issueNumber === issueNumber);
  if (manifests.length !== 1) throw new Error(`expected one delivery manifest for issue #${issueNumber}, found ${manifests.length}`);
  const manifest = manifests[0];
  if (manifest.schemaVersion !== 2 || manifest.workflowId !== workflowId) {
    throw new Error("delivery manifest is not linked to the current workflow");
  }
  if (manifest.lastVerifierSha !== expectedHead || !/^[0-9a-f]{64}$/.test(manifest.lastVerificationHash ?? "")) {
    throw new Error("fresh immutable verification receipt is missing");
  }
  const verification = await readGateReceipt(repoRoot, manifest.taskId, "verification", manifest.lastVerificationHash);
  if (!verification || verification.headSha !== expectedHead || verification.exitCode !== 0) {
    throw new Error("verification receipt does not match final HEAD");
  }
  if (!driver) throw new Error("CI driver is unavailable");
  const prHead = await driver.refreshHead({ repo: repoSlug, number: manifest.prNumber });
  if (prHead !== expectedHead) throw new Error("PR HEAD does not match final review HEAD");
  const required = adapter?.ci?.requiredChecks ?? [];
  const checks = await driver.readChecks({
    repo: repoSlug,
    number: manifest.prNumber,
    branch: manifest.branch,
    required,
  });
  const normalized = required.map((name) => {
    const observed = checks.find((check) => check.name === name);
    return { name, bucket: bucketFor(observed) };
  });
  const unhealthy = normalized.filter((check) => check.bucket !== "pass");
  if (unhealthy.length > 0) {
    throw new Error(`required CI is not passing: ${unhealthy.map((check) => `${check.name}:${check.bucket}`).join(", ")}`);
  }
  const { receipt: ci } = await publishGateReceipt(repoRoot, manifest.taskId, "ci", {
    headSha: expectedHead,
    prNumber: manifest.prNumber,
    checks: normalized,
  });
  return { verificationHash: verification.receiptHash, ciHash: ci.receiptHash, taskId: manifest.taskId };
}

async function loadOrBuildFinalPackage({ repoRoot, commonDir, workflowId, runState, planRecord, expectedHead, verificationHash, ciHash, gateTaskId }) {
  const reviewDir = join(opencodeShipStateDir(commonDir), "runs", workflowId, "final-review");
  const packagePath = join(reviewDir, "package.json");
  if (existsSync(packagePath)) {
    const existing = JSON.parse(await readFile(packagePath, "utf8"));
    if (existing.headSha !== expectedHead || existing.verificationHash !== verificationHash || existing.ciHash !== ciHash || existing.gateTaskId !== gateTaskId) {
      throw new Error("final review package already exists with different gate evidence");
    }
    return existing;
  }
  const actualHead = (await git(repoRoot, ["rev-parse", "HEAD"])).trim();
  if (actualHead !== expectedHead) {
    throw new Error(`HEAD drift before final review (expected ${expectedHead.slice(0, 8)}, got ${actualHead.slice(0, 8)})`);
  }
  const mergeBaseSha = String(planRecord.plan?.source?.baseSha ?? "");
  if (!/^[0-9a-f]{40}$/.test(mergeBaseSha)) throw new Error("approved plan base SHA is invalid");
  const observedMergeBase = (await git(repoRoot, ["merge-base", mergeBaseSha, actualHead])).trim();
  if (observedMergeBase !== mergeBaseSha) {
    throw new Error(`approved base ${mergeBaseSha.slice(0, 8)} is not the merge base of final HEAD`);
  }
  const revision = String(runState.revision).padStart(6, "0");
  const approvalRaw = await readFile(join(opencodeShipStateDir(commonDir), "plans", workflowId, "revisions", revision, "approval.json"), "utf8");
  const tasks = [];
  for (const completedTaskId of runState.completedTasks ?? []) {
    const commitRaw = await readFile(join(opencodeShipStateDir(commonDir), "runs", workflowId, "tasks", completedTaskId, "commit", "commit.json"), "utf8");
    const commit = JSON.parse(commitRaw);
    tasks.push({
      taskId: completedTaskId,
      commitSha: commit.commitSha,
      taskHash: sha256(commitRaw),
      reviewHash: commit.reviewHash,
    });
  }
  const pkg = buildFinalReviewPackage({
    workflowId,
    headSha: actualHead,
    mergeBaseSha,
    planHash: planRecord.hash,
    approvalHash: sha256(approvalRaw),
    gateTaskId,
    verificationHash,
    ciHash,
    tasks,
    builtAt: new Date().toISOString(),
  });
  await mkdir(reviewDir, { recursive: true });
  await publishImmutableJson(packagePath, pkg);
  return pkg;
}

function git(cwd, args) {
  return new Promise((resolveP, rejectP) => {
    execFile("git", ["-C", cwd, ...args], { cwd, shell: false }, (err, stdout, stderr) => {
      if (err) return rejectP(new Error(`git ${args[0]} failed: ${stderr || err.message}`));
      resolveP(String(stdout));
    });
  });
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
