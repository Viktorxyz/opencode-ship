/**
 * ship_task_start tool.
 *
 * Dispatch a task to the configured builder agent. The first
 * event recorded against the active run is TASK_DISPATCH; the
 * reducer preserves the task id across fix rounds so the at-most-
 * one-active-task invariant holds.
 *
 * The tool refuses to dispatch a task whose `id` is not declared
 * in the approved plan. The plan revision must be the latest
 * approved revision. The reviewer must be authorised against the
 * builder model so the runtime cannot be tricked into running a
 * reviewer as a builder.
 */
import { success, failure } from "./envelope.js";
import { readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveGitCommonDir, opencodeShipStateDir } from "../state/git-common-dir.js";
import { publishImmutableJson } from "../state/durable-store.js";
import { appendRunEvent, readRunState, RUN_EVENT_KINDS } from "../workflow/run-controller.js";
import { resolveModelRoles } from "../installer/engineering-config.js";
import { isSetupComplete } from "../installer/lock.js";
import { readLock } from "../installer/lock.js";

const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function createTaskStartTool(deps) {
  return async function taskStart(input) {
    const opId = input.operationId ?? `task-start-${Date.now().toString(36)}`;
    const workflowId = String(input.workflowId ?? "");
    const taskId = String(input.taskId ?? "");
    const briefHash = String(input.briefHash ?? "");
    const sessionID = String(input.sessionID ?? "");
    const submittedBy = String(input.submittedBy ?? "");
    if (!workflowId || !SAFE_ID_RE.test(workflowId)) {
      return failure("task-start", "workflowId required (safe id)", { operationId: opId, retryable: false });
    }
    if (!taskId || !SAFE_ID_RE.test(taskId)) {
      return failure("task-start", "taskId required (safe id)", { operationId: opId, retryable: false });
    }
    if (!briefHash || !/^[0-9a-f]{64}$/.test(briefHash)) {
      return failure("task-start", "briefHash required (sha256)", { operationId: opId, retryable: false });
    }
    if (!sessionID) {
      return failure("task-start", "sessionID required (must identify builder session)", { operationId: opId, retryable: false });
    }
    if (!submittedBy) {
      return failure("task-start", "submittedBy required (must identify builder model)", { operationId: opId, retryable: false });
    }
    const lock = await readLock(deps.repoRoot);
    if (!isSetupComplete(lock)) {
      return failure("task-start", "setup is not complete; run /setup-ship-workflow first", { operationId: opId, retryable: false });
    }
    let models;
    try {
      models = resolveModelRoles(deps.config?.workflow, { strict: true });
    } catch (err) {
      return failure("task-start", `builder model unresolved: ${err?.message ?? err}`, { operationId: opId, retryable: false });
    }
    if (!submittedBy.startsWith(models.builder)) {
      return failure("task-start", `submittedBy must be the configured builder model ${models.builder}`, { operationId: opId, retryable: false });
    }
    let runState;
    try {
      runState = await readRunState(deps.repoRoot, workflowId);
    } catch (err) {
      return failure("task-start", `run state unreadable: ${err?.message ?? err}`, { operationId: opId, retryable: false });
    }
    if (!runState) {
      return failure("task-start", "run not started", { operationId: opId, retryable: false });
    }
    try {
      const commonDir = await resolveGitCommonDir(deps.repoRoot);
      const dispatchDir = join(opencodeShipStateDir(commonDir), "runs", workflowId, "tasks", taskId, "dispatch");
      await mkdir(dispatchDir, { recursive: true });
      const record = {
        workflowId,
        taskId,
        sessionID,
        builder: models.builder,
        briefHash,
        dispatchedAt: new Date().toISOString(),
      };
      await publishImmutableJson(join(dispatchDir, "dispatch.json"), record);
      const { state, event } = await appendRunEvent(
        deps.repoRoot,
        workflowId,
        runState,
        { kind: RUN_EVENT_KINDS.TASK_DISPATCH, data: { taskId, briefHash, sessionID } },
      );
      return success("task-start", { workflowId, taskId, state: state.state, sequence: event.sequence, round: state.round }, { operationId: opId });
    } catch (err) {
      return failure("task-start", String(err?.message ?? err), { operationId: opId, retryable: true });
    }
  };
}
