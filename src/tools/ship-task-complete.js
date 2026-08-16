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
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveGitCommonDir, opencodeShipStateDir } from "../state/git-common-dir.js";
import { publishImmutableJson } from "../state/durable-store.js";
import { appendRunEvent, readRunState, RUN_EVENT_KINDS } from "../workflow/run-controller.js";
import { readLock, isSetupComplete } from "../installer/lock.js";

const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function createTaskCompleteTool(deps) {
  return async function taskComplete(input) {
    const opId = input.operationId ?? `task-complete-${Date.now().toString(36)}`;
    const workflowId = String(input.workflowId ?? "");
    const taskId = String(input.taskId ?? "");
    const moreTasks = input.moreTasks === false ? false : input.moreTasks === true ? true : null;
    const nextTaskId = input.nextTaskId ? String(input.nextTaskId) : null;
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
    if (runState.state !== "committed") {
      return failure("task-complete", `task-commit must precede task-complete; run state=${runState.state}`, { operationId: opId, retryable: false });
    }
    try {
      const commonDir = await resolveGitCommonDir(deps.repoRoot);
      const completeDir = join(opencodeShipStateDir(commonDir), "runs", workflowId, "tasks", taskId, "complete");
      await mkdir(completeDir, { recursive: true });
      const record = {
        workflowId,
        taskId,
        moreTasks,
        nextTaskId: nextTaskId ?? null,
        completedAt: new Date().toISOString(),
      };
      await publishImmutableJson(join(completeDir, "complete.json"), record);
      const { state, event } = await appendRunEvent(
        deps.repoRoot,
        workflowId,
        runState,
        { kind: RUN_EVENT_KINDS.TASK_COMPLETE, data: { taskId, moreTasks, nextTaskId: nextTaskId ?? null } },
      );
      return success("task-complete", {
        workflowId,
        taskId,
        moreTasks,
        nextTaskId: nextTaskId ?? null,
        state: state.state,
        sequence: event.sequence,
      }, { operationId: opId });
    } catch (err) {
      return failure("task-complete", String(err?.message ?? err), { operationId: opId, retryable: true });
    }
  };
}
