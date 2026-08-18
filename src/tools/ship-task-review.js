/**
 * ship_task_review tool.
 *
 * Task-reviewer verdict with explicit Spec and Quality axes. The
 * caller must supply both axes; the tool refuses to record a
 * combined verdict. Authorization requires the ToolContext
 * session id to match the recorded task-reviewer child session
 * for the same task + round. The reviewer is dispatched by the
 * controller when the matching report lands.
 */

import { success, failure } from "./envelope.js";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveGitCommonDir, opencodeShipStateDir } from "../state/git-common-dir.js";
import { publishImmutableJson } from "../state/durable-store.js";
import { appendRunEvent, readRunState, RUN_EVENT_KINDS } from "../workflow/run-controller.js";
import { isSetupComplete, readLock } from "../installer/lock.js";
import { authorizeChildCall, dispatchWorker, ROLES } from "../runtime/opencode-dispatcher.js";

const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const VERDICT_VALUES = new Set(["pass", "fail", "none"]);

export function createTaskReviewTool(deps) {
  return async function taskReview(input) {
    const opId = input.operationId ?? `task-review-${Date.now().toString(36)}`;
    const workflowId = String(input.workflowId ?? "");
    const taskId = String(input.taskId ?? "");
    const round = Number(input.round ?? 1);
    const spec = input.spec;
    const quality = input.quality;
    if (!workflowId || !SAFE_ID_RE.test(workflowId)) {
      return failure("task-review", "workflowId required (safe id)", { operationId: opId, retryable: false });
    }
    if (!taskId || !SAFE_ID_RE.test(taskId)) {
      return failure("task-review", "taskId required (safe id)", { operationId: opId, retryable: false });
    }
    if (!Number.isInteger(round) || round <= 0) {
      return failure("task-review", "round must be a positive integer", { operationId: opId, retryable: false });
    }
    if (!spec || typeof spec !== "object" || !VERDICT_VALUES.has(String(spec.verdict ?? ""))) {
      return failure("task-review", "spec verdict required (pass|fail|none)", { operationId: opId, retryable: false });
    }
    if (!quality || typeof quality !== "object" || !VERDICT_VALUES.has(String(quality.verdict ?? ""))) {
      return failure("task-review", "quality verdict required (pass|fail|none)", { operationId: opId, retryable: false });
    }
    const ctx = input.ctx ?? deps.ctx ?? null;
    const auth = await authorizeChildCall(
      deps.repoRoot,
      workflowId,
      ROLES.TASK_REVIEWER,
      { taskId, round },
      ctx,
    );
    if (!auth.ok) {
      return failure("task-review", `task-reviewer authorization failed: ${auth.message}`, { operationId: opId, retryable: false });
    }
    const lock = await readLock(deps.repoRoot);
    if (!isSetupComplete(lock)) {
      return failure("task-review", "setup is not complete; run /setup-ship-workflow first", { operationId: opId, retryable: false });
    }
    let runState;
    try {
      runState = await readRunState(deps.repoRoot, workflowId);
    } catch (err) {
      return failure("task-review", `run state unreadable: ${err?.message ?? err}`, { operationId: opId, retryable: false });
    }
    if (!runState) {
      return failure("task-review", "run not started", { operationId: opId, retryable: false });
    }
    const reviewHash = verdictHash({ spec, quality, taskId, round });
    const priorEvent = runState.events.find((event) => event.kind === RUN_EVENT_KINDS.TASK_REVIEW && event.data?.reviewHash === reviewHash);
    if (priorEvent) {
      return success("task-review", {
        workflowId,
        taskId,
        round,
        reviewerSessionID: auth.sessionID,
        reviewHash,
        state: runState.state,
        sequence: priorEvent.sequence,
      }, { operationId: opId, idempotent: true });
    }
    if (runState.activeTask !== taskId) {
      return failure("task-review", `no active task ${taskId} (active=${runState.activeTask})`, { operationId: opId, retryable: false });
    }
    try {
      const specPass = String(spec.verdict) === "pass";
      const qualityPass = String(quality.verdict) === "pass";
      const commonDir = await resolveGitCommonDir(deps.repoRoot);
      const reviewDir = join(opencodeShipStateDir(commonDir), "runs", workflowId, "tasks", taskId, "rounds", `${String(round).padStart(4, "0")}`);
      await mkdir(reviewDir, { recursive: true });
      const record = {
        workflowId,
        taskId,
        round,
        reviewerSessionID: auth.sessionID,
        spec,
        quality,
        state: specPass && qualityPass ? "commit-pending" : "fix-pending",
        reviewedAt: new Date().toISOString(),
      };
      const reviewPath = join(reviewDir, "review.json");
      if (existsSync(reviewPath)) {
        const existing = JSON.parse(await readFile(reviewPath, "utf8"));
        if (
          existing.workflowId !== workflowId
          || existing.taskId !== taskId
          || existing.round !== round
          || existing.reviewerSessionID !== auth.sessionID
          || JSON.stringify(existing.spec) !== JSON.stringify(spec)
          || JSON.stringify(existing.quality) !== JSON.stringify(quality)
        ) {
          return failure("task-review", "immutable task review conflicts with retry", { operationId: opId, retryable: false });
        }
      } else {
        await publishImmutableJson(reviewPath, record);
      }
      const verdict = specPass && qualityPass ? "pass" : "fail";
      const { state, event } = await appendRunEvent(
        deps.repoRoot,
        workflowId,
        runState,
        {
          kind: RUN_EVENT_KINDS.TASK_REVIEW,
          data: { taskId, verdict, reviewHash, round, sessionID: auth.sessionID },
        },
      );
      return success("task-review", {
        workflowId,
        taskId,
        round,
        reviewerSessionID: auth.sessionID,
        reviewHash,
        state: state.state,
        sequence: event.sequence,
      }, { operationId: opId });
    } catch (err) {
      return failure("task-review", String(err?.message ?? err), { operationId: opId, retryable: true });
    }
  };
}

function verdictHash(record) {
  const sorted = Object.keys(record).sort();
  const ordered = {};
  for (const k of sorted) ordered[k] = record[k];
  return createHash("sha256").update(JSON.stringify(ordered), "utf8").digest("hex");
}
