/**
 * ship_plan_approve tool.
 *
 * Seals the immutable approval record. The caller MUST provide
 * the recorded user permission subject string from the controller's
 * `ctx.ask` flow. The approval record is published immutably
 * through the canonical plan-store helper so the seal, mirror,
 * and index update are atomic.
 */

import { success, failure } from "./envelope.js";
import { publishApproval, readPlanRevision } from "../workflow/plan-store.js";
import { authorizeControllerCall } from "../runtime/opencode-dispatcher.js";

const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function createPlanApproveTool(deps) {
  return async function planApprove(input) {
    const opId = input.operationId ?? `plan-approve-${Date.now().toString(36)}`;
    const workflowId = String(input.workflowId ?? "");
    const revision = Number(input.revision);
    const sha256 = String(input.sha256 ?? "");
    const subject = String(input.subject ?? "");
    if (!workflowId || !SAFE_ID_RE.test(workflowId)) {
      return failure("plan-approve", "workflowId required (safe id)", { operationId: opId, retryable: false });
    }
    if (!Number.isInteger(revision) || revision <= 0) {
      return failure("plan-approve", "revision required", { operationId: opId, retryable: false });
    }
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      return failure("plan-approve", "sha256 required (64 hex chars)", { operationId: opId, retryable: false });
    }
    if (!subject) {
      return failure("plan-approve", "user permission subject required", { operationId: opId, retryable: false });
    }
    const ctx = input.ctx ?? deps.ctx ?? null;
    const auth = await authorizeControllerCall(deps.repoRoot, workflowId, ctx);
    if (!auth.ok) {
      return failure("plan-approve", `controller authorization failed: ${auth.message}`, { operationId: opId, retryable: false });
    }
    try {
      const planRecord = await readPlanRevision(deps.repoRoot, workflowId, revision);
      if (!planRecord || planRecord.hash !== sha256) {
        return failure("plan-approve", "plan revision is missing or does not match sha256", { operationId: opId, retryable: false });
      }
      const result = await publishApproval(deps.repoRoot, {
        workflowId,
        revision,
        decision: "approved",
        sessionID: auth.sessionID,
        approvedBy: subject,
        approvedAt: new Date().toISOString(),
        chunkIds: Array.isArray(input.chunkIds) ? input.chunkIds : [],
        chunkHashes: Array.isArray(input.chunkHashes) ? input.chunkHashes : [],
        baseSha: planRecord.plan.source.baseSha,
        models: planRecord.plan.models ?? deps.configValue?.workflow?.models ?? null,
        sha256,
      });
      return success("plan-approve", {
        workflowId,
        revision,
        sha256,
        recorded: result.recorded,
      }, { operationId: opId });
    } catch (err) {
      return failure("plan-approve", String(err?.message ?? err), { operationId: opId, retryable: true });
    }
  };
}
