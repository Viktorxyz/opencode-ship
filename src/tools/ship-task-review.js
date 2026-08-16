/**
 * ship_task_review tool.
 *
 * Task-reviewer verdict with explicit Spec and Quality axes. The
 * caller must supply both axes; the tool refuses to record a
 * combined verdict. The verdict is published immutably through
 * the controller appendRunEvent so the run ledger is hash-chained.
 */

import { success, failure } from "./envelope.js";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveGitCommonDir, opencodeShipStateDir } from "../state/git-common-dir.js";
import { publishImmutableJson } from "../state/durable-store.js";
import { appendRunEvent, readRunState, RUN_EVENT_KINDS } from "../workflow/run-controller.js";
import { resolveModelRoles } from "../installer/engineering-config.js";

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
    const submittedBy = String(input.submittedBy ?? "");
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
    if (!submittedBy) {
      return failure("task-review", "submittedBy required (must identify reviewer model)", { operationId: opId, retryable: false });
    }
    let models;
    try {
      models = resolveModelRoles(deps.config?.workflow, { strict: true });
    } catch (err) {
      return failure("task-review", `reviewer model unresolved: ${err?.message ?? err}`, { operationId: opId, retryable: false });
    }
    if (!submittedBy.startsWith(models.builder)) {
      return failure("task-review", `submittedBy must be the configured builder model ${models.builder}`, { operationId: opId, retryable: false });
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
    if (runState.activeTask !== taskId) {
      return failure("task-review", `no active task ${taskId} (active=${runState.activeTask})`, { operationId: opId, retryable: false });
    }
    try {
      const commonDir = await resolveGitCommonDir(deps.repoRoot);
      const reviewDir = join(opencodeShipStateDir(commonDir), "runs", workflowId, "tasks", taskId, "rounds", `${String(round).padStart(4, "0")}`);
      await mkdir(reviewDir, { recursive: true });
      const specPass = String(spec.verdict) === "pass";
      const qualityPass = String(quality.verdict) === "pass";
      const reviewHash = verdictHash({ spec, quality, submittedBy, taskId, round });
      const record = {
        workflowId,
        taskId,
        round,
        submittedBy,
        reviewer: models.builder,
        spec,
        quality,
        state: specPass && qualityPass ? "commit-pending" : "fix-pending",
        reviewedAt: new Date().toISOString(),
      };
      await publishImmutableJson(join(reviewDir, "review.json"), record);
      const verdict = specPass && qualityPass ? "pass" : "fail";
      const { state, event } = await appendRunEvent(
        deps.repoRoot,
        workflowId,
        runState,
        { kind: RUN_EVENT_KINDS.TASK_REVIEW, data: { taskId, verdict, reviewHash, round } },
      );
      return success("task-review", { workflowId, taskId, round, state: state.state, sequence: event.sequence }, { operationId: opId });
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
