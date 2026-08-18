/**
 * ship_resume tool.
 *
 * Reconciles a workflow from durable state. Delegates to
 * `resumeRun` so every resume is serialised by the per-run
 * lock and returns the same next action when invoked twice.
 * The compact status payload tells the controller exactly
 * which command to invoke next.
 */

import { success, failure } from "./envelope.js";
import { resumeRun } from "../workflow/resume.js";
import { withControllerLease } from "../runtime/opencode-dispatcher.js";

const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function createResumeTool(deps) {
  return async function resume(input) {
    const opId = input.operationId ?? `resume-${Date.now().toString(36)}`;
    const workflowId = String(input.workflowId ?? "");
    if (!workflowId || !SAFE_ID_RE.test(workflowId)) {
      return failure("resume", "workflowId required (safe id)", { operationId: opId, retryable: false });
    }
    const ctx = input.ctx ?? deps.ctx ?? null;
    if (!ctx || typeof ctx.sessionID !== "string" || ctx.agent !== "ship-controller") {
      return failure("resume", "ToolContext must identify the ship-controller session", { operationId: opId, retryable: false });
    }
    try {
      const result = await withControllerLease(
        deps.repoRoot,
        workflowId,
        ctx.sessionID,
        () => resumeRun(deps.repoRoot, workflowId),
      );
      return success("resume", {
        workflowId,
        state: result.state,
        nextAction: result.nextAction,
        mirrored: result.mirrored ?? false,
      }, { operationId: opId });
    } catch (err) {
      return failure("resume", String(err?.message ?? err), { operationId: opId, retryable: true });
    }
  };
}
