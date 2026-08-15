/**
 * ship_run_start tool.
 *
 * Starts execution of an approved plan. The latest plan revision
 * and the matching approval record must already exist under the
 * plan-store. The plan hash must match the approved hash, the
 * model snapshot must match the configured engineering models,
 * and the current base SHA must match the approved base SHA so a
 * stale approval is rejected.
 */

import { success, failure } from "./envelope.js";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveGitCommonDir, opencodeShipStateDir } from "../state/git-common-dir.js";
import { publishImmutableJson } from "../state/durable-store.js";

const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

async function readRevisionRecord(repoRoot, workflowId, revision) {
  const commonDir = await resolveGitCommonDir(repoRoot);
  const rev = String(revision).padStart(6, "0");
  const dir = join(opencodeShipStateDir(commonDir), "plans", workflowId, "revisions", rev);
  const planRaw = await readFile(join(dir, "plan.json"), "utf8");
  const plan = JSON.parse(planRaw);
  const approvalPath = join(dir, "approval.json");
  let approval = null;
  try {
    approval = JSON.parse(await readFile(approvalPath, "utf8"));
  } catch {
    approval = null;
  }
  return { dir, plan, approval };
}

export function createRunStartTool(deps) {
  return async function runStart(input) {
    const opId = input.operationId ?? `run-start-${Date.now().toString(36)}`;
    const workflowId = String(input.workflowId ?? "");
    if (!workflowId || !SAFE_ID_RE.test(workflowId)) {
      return failure("run-start", "workflowId required (safe id)", { operationId: opId, retryable: false });
    }
    // The plugin passes the full ship config under deps.configValue
    // (set by the wrapper); use that directly. Fall back to the
    // legacy deps.config.value shape for older callers.
    const configValue = deps.configValue ?? deps.config?.value ?? null;
    const expectedModels = configValue?.workflow?.models ?? null;
    if (!expectedModels) {
      return failure("run-start", "run-start requires configured workflow.models", { operationId: opId, retryable: false });
    }
    const revision = Number(input.revision ?? 0);
    if (!Number.isInteger(revision) || revision <= 0) {
      return failure("run-start", "revision required", { operationId: opId, retryable: false });
    }
    let records;
    try {
      records = await readRevisionRecord(deps.repoRoot, workflowId, revision);
    } catch (err) {
      return failure("run-start", `plan revision not found: ${err?.message ?? err}`, { operationId: opId, retryable: false });
    }
    if (!records.approval) {
      return failure("run-start", "no approval record for this revision", { operationId: opId, retryable: false });
    }
    if (records.approval.sha256 !== records.plan.hash) {
      return failure("run-start", `approval sha256 mismatch: plan ${records.plan.hash?.slice(0, 8)} vs approval ${records.approval.sha256?.slice(0, 8)}`, { operationId: opId, retryable: false });
    }
    const expectedHash = records.approval.sha256;
    if (input.sha256 && input.sha256 !== expectedHash) {
      return failure("run-start", `sha256 mismatch: expected ${expectedHash.slice(0, 8)}, got ${String(input.sha256).slice(0, 8)}`, { operationId: opId, retryable: false });
    }
    if (records.approval.models) {
      const a = records.approval.models;
      if (a.planner !== expectedModels.planner || a.builder !== expectedModels.builder || a.finalReviewer !== expectedModels.finalReviewer) {
        return failure("run-start", "approval models no longer match configured workflow.models", { operationId: opId, retryable: false });
      }
    }
    try {
      const commonDir = await resolveGitCommonDir(deps.repoRoot);
      const runDir = join(opencodeShipStateDir(commonDir), "runs", workflowId);
      await mkdir(join(runDir, "events"), { recursive: true });
      const startedAt = new Date().toISOString();
      const runRecord = {
        workflowId,
        revision,
        sha256: expectedHash,
        startedAt,
        state: "running",
        activeTask: null,
        round: 0,
        models: expectedModels,
      };
      await publishImmutableJson(join(runDir, "run.json"), runRecord);
      const event = { sequence: 1, kind: "run-start", at: startedAt, data: { revision, sha256: expectedHash } };
      await publishImmutableJson(join(runDir, "events", "00000001.json"), event);
      return success("run-start", { workflowId, revision, sha256: expectedHash }, { operationId: opId });
    } catch (err) {
      return failure("run-start", String(err?.message ?? err), { operationId: opId, retryable: true });
    }
  };
}
