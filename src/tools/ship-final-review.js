/**
 * ship_final_review tool.
 *
 * Records one final review axis (standards or spec) for the
 * active run. The reducer collects both axes in the run
 * snapshot. Bound to the same HEAD, merge-base SHA, and
 * package hash the reviewer is attesting against.
 *
 * The caller must be authorised against the configured
 * finalReviewer model. A caller-supplied `submittedBy` alone
 * is not sufficient; the tool checks the model prefix and
 * the latest run snapshot to ensure the model has actually
 * been dispatched.
 */
import { success, failure } from "./envelope.js";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveGitCommonDir, opencodeShipStateDir } from "../state/git-common-dir.js";
import { publishImmutableJson } from "../state/durable-store.js";
import { appendRunEvent, readRunState, RUN_EVENT_KINDS } from "../workflow/run-controller.js";
import { resolveModelRoles } from "../installer/engineering-config.js";
import { readLock, isSetupComplete } from "../installer/lock.js";

const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const AXES = new Set(["standards", "spec"]);
const VERDICTS = new Set(["pass", "fail", "blocked"]);

export function createFinalReviewTool(deps) {
  return async function finalReview(input) {
    const opId = input.operationId ?? `final-review-${Date.now().toString(36)}`;
    const workflowId = String(input.workflowId ?? "");
    const axis = String(input.axis ?? "");
    const verdict = String(input.verdict ?? "");
    const headSha = String(input.headSha ?? "");
    const mergeBaseSha = String(input.mergeBaseSha ?? "");
    const packageHash = String(input.packageHash ?? "");
    const submittedBy = String(input.submittedBy ?? "");
    const findings = Array.isArray(input.findings) ? input.findings : [];
    if (!workflowId || !SAFE_ID_RE.test(workflowId)) {
      return failure("final-review", "workflowId required (safe id)", { operationId: opId, retryable: false });
    }
    if (!AXES.has(axis)) {
      return failure("final-review", "axis must be 'standards' or 'spec'", { operationId: opId, retryable: false });
    }
    if (!VERDICTS.has(verdict)) {
      return failure("final-review", "verdict must be one of pass|fail|blocked", { operationId: opId, retryable: false });
    }
    if (!/^[0-9a-f]{40}$/.test(headSha)) {
      return failure("final-review", "headSha required (40-char commit SHA)", { operationId: opId, retryable: false });
    }
    if (!/^[0-9a-f]{40}$/.test(mergeBaseSha)) {
      return failure("final-review", "mergeBaseSha required (40-char commit SHA)", { operationId: opId, retryable: false });
    }
    if (!/^[0-9a-f]{64}$/.test(packageHash)) {
      return failure("final-review", "packageHash required (sha256)", { operationId: opId, retryable: false });
    }
    if (!submittedBy) {
      return failure("final-review", "submittedBy required (must identify finalReviewer model)", { operationId: opId, retryable: false });
    }
    const lock = await readLock(deps.repoRoot);
    if (!isSetupComplete(lock)) {
      return failure("final-review", "setup is not complete; run /setup-ship-workflow first", { operationId: opId, retryable: false });
    }
    let models;
    try {
      models = resolveModelRoles(deps.config?.workflow, { strict: true });
    } catch (err) {
      return failure("final-review", `final reviewer model unresolved: ${err?.message ?? err}`, { operationId: opId, retryable: false });
    }
    if (!submittedBy.startsWith(models.finalReviewer)) {
      return failure("final-review", `submittedBy must be the configured finalReviewer model ${models.finalReviewer}`, { operationId: opId, retryable: false });
    }
    let runState;
    try {
      runState = await readRunState(deps.repoRoot, workflowId);
    } catch (err) {
      return failure("final-review", `run state unreadable: ${err?.message ?? err}`, { operationId: opId, retryable: false });
    }
    if (!runState) {
      return failure("final-review", "run not started", { operationId: opId, retryable: false });
    }
    if (runState.state !== "all-tasks-done" && runState.state !== "ready-pending") {
      return failure("final-review", `final review requires all-tasks-done; run state=${runState.state}`, { operationId: opId, retryable: false });
    }
    try {
      const commonDir = await resolveGitCommonDir(deps.repoRoot);
      const reviewDir = join(opencodeShipStateDir(commonDir), "runs", workflowId, "final-review", axis);
      await mkdir(reviewDir, { recursive: true });
      const record = {
        workflowId,
        axis,
        verdict,
        headSha,
        mergeBaseSha,
        packageHash,
        submittedBy,
        reviewer: models.finalReviewer,
        findings,
        reviewedAt: new Date().toISOString(),
      };
      await publishImmutableJson(join(reviewDir, "review.json"), record);
      const { state, event } = await appendRunEvent(
        deps.repoRoot,
        workflowId,
        runState,
        {
          kind: RUN_EVENT_KINDS.FINAL_REVIEW,
          data: {
            axis,
            verdict,
            headSha,
            mergeBaseSha,
            packageHash,
            review: { verdict, headSha, mergeBaseSha, packageHash },
          },
        },
      );
      return success("final-review", {
        workflowId,
        axis,
        verdict,
        headSha,
        state: state.state,
        sequence: event.sequence,
        finalReview: state.finalReview ?? null,
      }, { operationId: opId });
    } catch (err) {
      return failure("final-review", String(err?.message ?? err), { operationId: opId, retryable: true });
    }
  };
}
