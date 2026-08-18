/**
 * ship_final_review tool.
 *
 * Records one final review axis (standards or spec) for the
 * active run. Authorization requires the ToolContext session id
 * to match the recorded Standards or Spec final-reviewer child
 * session for the same immutable package hash.
 *
 * The Standards and Spec reviews must bind to the same HEAD,
 * merge-base SHA, and package hash. A caller-supplied
 * `submittedBy` alone is insufficient.
 */

import { success, failure } from "./envelope.js";
import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveGitCommonDir, opencodeShipStateDir } from "../state/git-common-dir.js";
import { publishImmutableJson } from "../state/durable-store.js";
import { appendRunEvent, readRunState, RUN_EVENT_KINDS } from "../workflow/run-controller.js";
import { isSetupComplete, readLock } from "../installer/lock.js";
import { authorizeChildCall, ROLES } from "../runtime/opencode-dispatcher.js";
import { hashAxisRecord, hashFinalReviewPackage } from "../workflow/final-review.js";

const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const AXES = new Set(["standards", "spec"]);
const VERDICTS = new Set(["pass", "fail", "blocked"]);

const ROLE_FOR_AXIS = {
  standards: ROLES.FINAL_STANDARDS,
  spec: ROLES.FINAL_SPEC,
};

export function createFinalReviewTool(deps) {
  return async function finalReview(input) {
    const opId = input.operationId ?? `final-review-${Date.now().toString(36)}`;
    const workflowId = String(input.workflowId ?? "");
    const axis = String(input.axis ?? "");
    const verdict = String(input.verdict ?? "");
    const headSha = String(input.headSha ?? "");
    const mergeBaseSha = String(input.mergeBaseSha ?? "");
    const packageHash = String(input.packageHash ?? "");
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
    const ctx = input.ctx ?? deps.ctx ?? null;
    const auth = await authorizeChildCall(
      deps.repoRoot,
      workflowId,
      ROLE_FOR_AXIS[axis],
      { packageHash },
      ctx,
    );
    if (!auth.ok) {
      return failure("final-review", `final reviewer authorization failed: ${auth.message}`, { operationId: opId, retryable: false });
    }
    const lock = await readLock(deps.repoRoot);
    if (!isSetupComplete(lock)) {
      return failure("final-review", "setup is not complete; run /setup-ship-workflow first", { operationId: opId, retryable: false });
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
      const packagePath = join(opencodeShipStateDir(commonDir), "runs", workflowId, "final-review", "package.json");
      if (!existsSync(packagePath)) {
        return failure("final-review", "canonical final review package is missing", { operationId: opId, retryable: false });
      }
      const finalPackage = JSON.parse(await readFile(packagePath, "utf8"));
      if (hashFinalReviewPackage(finalPackage) !== finalPackage.packageHash) {
        return failure("final-review", "canonical final review package hash is invalid", { operationId: opId, retryable: false });
      }
      if (finalPackage.packageHash !== packageHash || finalPackage.headSha !== headSha || finalPackage.mergeBaseSha !== mergeBaseSha) {
        return failure("final-review", "review input does not match the canonical final review package", { operationId: opId, retryable: false });
      }
      const reviewDir = join(opencodeShipStateDir(commonDir), "runs", workflowId, "final-review", axis);
      await mkdir(reviewDir, { recursive: true });
      let record = {
        workflowId,
        axis,
        verdict,
        headSha,
        mergeBaseSha,
        packageHash,
        reviewerSessionID: auth.sessionID,
        reviewerModel: String(deps.config?.workflow?.models?.finalReviewer ?? "unknown/unknown"),
        findings,
        reviewedAt: new Date().toISOString(),
      };
      const reviewPath = join(reviewDir, "review.json");
      if (existsSync(reviewPath)) {
        record = JSON.parse(await readFile(reviewPath, "utf8"));
        if (
          record.axis !== axis
          || record.verdict !== verdict
          || record.headSha !== headSha
          || record.mergeBaseSha !== mergeBaseSha
          || record.packageHash !== packageHash
          || record.reviewerSessionID !== auth.sessionID
          || hashAxisRecord(/** @type {any} */ (record)) !== record.reviewHash
        ) {
          return failure("final-review", "immutable final review record conflicts with retry", { operationId: opId, retryable: false });
        }
      } else {
        record.reviewHash = hashAxisRecord(/** @type {any} */ (record));
        await publishImmutableJson(reviewPath, record);
      }
      if (runState.finalReview?.[axis]?.reviewHash === record.reviewHash) {
        return success("final-review", {
          workflowId,
          axis,
          verdict,
          headSha,
          reviewerSessionID: auth.sessionID,
          state: runState.state,
          sequence: runState.events.at(-1)?.sequence ?? 0,
          finalReview: runState.finalReview,
        }, { operationId: opId, idempotent: true });
      }
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
            sessionID: auth.sessionID,
            review: { verdict, headSha, mergeBaseSha, packageHash, reviewHash: record.reviewHash },
          },
        },
      );
      return success("final-review", {
        workflowId,
        axis,
        verdict,
        headSha,
        reviewerSessionID: auth.sessionID,
        state: state.state,
        sequence: event.sequence,
        finalReview: state.finalReview ?? null,
      }, { operationId: opId });
    } catch (err) {
      return failure("final-review", String(err?.message ?? err), { operationId: opId, retryable: true });
    }
  };
}
