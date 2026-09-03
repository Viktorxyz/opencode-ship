/**
 * ship_task_start tool.
 *
 * Controller-only: dispatch the configured builder child session
 * for a specific task and round. The ToolContext must hold the
 * active controller lease; the builder child session id is
 * recorded against the dispatch key `builder:<taskId>:<round>`.
 *
 * Authorization happens via the controller lease and the
 * dispatcher (`authorizeControllerCall` + `dispatchWorker`).
 */

import { success, failure } from "./envelope.js";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveGitCommonDir, opencodeShipStateDir } from "../state/git-common-dir.js";
import { publishImmutableJson } from "../state/durable-store.js";
import { appendRunEvent, readRunState, RUN_EVENT_KINDS } from "../workflow/run-controller.js";
import { resolveModelRoles } from "../installer/engineering-config.js";
import { isSetupComplete, readLock } from "../installer/lock.js";
import { dispatchWorker, authorizeControllerCall, ROLES } from "../runtime/opencode-dispatcher.js";
import { readPlanRevision } from "../workflow/plan-store.js";
import { canonicalJson } from "../installer/json-pointer.js";
import { createHash } from "node:crypto";
import { resolveWorkflowWorktree } from "../workflow/worktree-resolver.js";
import { nextLine, progressLine } from "../runtime/stages.js";

const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function createTaskStartTool(deps) {
  return async function taskStart(input) {
    const opId = input.operationId ?? `task-start-${Date.now().toString(36)}`;
    const workflowId = String(input.workflowId ?? "");
    const taskId = String(input.taskId ?? "");
    if (!workflowId || !SAFE_ID_RE.test(workflowId)) {
      return failure("task-start", "workflowId required (safe id)", { operationId: opId, retryable: false });
    }
    if (!taskId || !SAFE_ID_RE.test(taskId)) {
      return failure("task-start", "taskId required (safe id)", { operationId: opId, retryable: false });
    }
    const ctx = input.ctx ?? deps.ctx ?? null;
    const auth = await authorizeControllerCall(deps.repoRoot, workflowId, ctx);
    if (!auth.ok) {
      return failure("task-start", `controller authorization failed: ${auth.message}`, { operationId: opId, retryable: false });
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
    let runState;
    try {
      runState = await readRunState(deps.repoRoot, workflowId);
    } catch (err) {
      return failure("task-start", `run state unreadable: ${err?.message ?? err}`, { operationId: opId, retryable: false });
    }
    if (!runState) {
      return failure("task-start", "run not started", { operationId: opId, retryable: false });
    }
    const planRecord = await readPlanRevision(deps.repoRoot, workflowId, runState.revision);
    if (!planRecord || planRecord.hash !== runState.sha256) {
      return failure("task-start", "approved plan is missing or does not match the run", { operationId: opId, retryable: false });
    }
    const remainingTasks = planRecord.plan.tasks.filter((task) => !runState.completedTasks.includes(task.id));
    const task = remainingTasks[0];
    if (!task || task.id !== taskId) {
      return failure("task-start", `task ${taskId} is not the next task in the approved plan`, { operationId: opId, retryable: false });
    }
    const unsatisfied = (task.dependsOn ?? []).filter((dependency) => !runState.completedTasks.includes(dependency));
    if (unsatisfied.length > 0) {
      return failure("task-start", `task dependencies are incomplete: ${unsatisfied.join(", ")}`, { operationId: opId, retryable: false });
    }
    const briefHash = createHash("sha256").update(canonicalJson(task), "utf8").digest("hex");
    const round = runState.round > 0 ? runState.round : 1;
    try {
      const resolved = await resolveWorkflowWorktree(deps.repoRoot, workflowId);
      if (!resolved.ok) {
        return failure("task-start", `workflow worktree resolution failed: ${resolved.kind}`, {
          operationId: opId,
          retryable: false,
          details: resolved,
        });
      }
      let dispatchResult = null;
      if (deps.opencodeClient) {
        dispatchResult = await dispatchWorker({
          repoRoot: resolved.worktreePath,
          workflowId,
          role: ROLES.BUILDER,
          keyInput: { taskId, round },
          payload: {
            promptText: [
              `Implement workflow ${workflowId} task ${taskId} round ${round}.`,
              `Call ship_task_report with workflowId=${workflowId}, taskId=${taskId}, and round=${round}.`,
              `Approved task brief:\n${JSON.stringify(task, null, 2)}`,
            ].join("\n\n"),
          },
          client: deps.opencodeClient,
          parentSessionID: ctx.sessionID,
          titleMarker: `ship-task-builder-${workflowId}-${taskId}`,
          agent: "ship-task-builder",
          model: models.builder,
        });
      }
      const commonDir = await resolveGitCommonDir(deps.repoRoot);
      const dispatchDir = join(
        opencodeShipStateDir(commonDir),
        "runs",
        workflowId,
        "tasks",
        taskId,
        "rounds",
        String(round).padStart(4, "0"),
        "dispatch",
      );
      await mkdir(dispatchDir, { recursive: true });
      const record = {
        workflowId,
        taskId,
        round,
        builderSessionID: dispatchResult?.sessionID ?? null,
        dispatchKey: dispatchResult?.dispatchKey ?? null,
        controllerSessionID: ctx.sessionID,
        builder: models.builder,
        briefHash,
        task,
        dispatchedAt: new Date().toISOString(),
      };
      await publishImmutableJson(join(dispatchDir, "dispatch.json"), record);
      const { state, event } = await appendRunEvent(
        deps.repoRoot,
        workflowId,
        runState,
        {
          kind: RUN_EVENT_KINDS.TASK_DISPATCH,
          data: { taskId, briefHash, sessionID: dispatchResult?.sessionID ?? null },
        },
      );
      return success("task-start", {
        workflowId,
        taskId,
        builderSessionID: dispatchResult?.sessionID ?? null,
        dispatchKey: dispatchResult?.dispatchKey ?? null,
        state: state.state,
        sequence: event.sequence,
        round: state.round,
        progress: progressLine("build", { k: 1, n: 1, title: taskId }),
        next: nextLine("build"),
      }, { operationId: opId });
    } catch (err) {
      return failure("task-start", String(err?.message ?? err), { operationId: opId, retryable: true });
    }
  };
}
