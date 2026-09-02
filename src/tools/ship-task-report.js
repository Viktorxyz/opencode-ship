/**
 * ship_task_report tool.
 *
 * Builder-only immutable report. The ToolContext session id
 * must match the recorded builder child session for the same
 * task + round. The report is published immutably through the
 * controller appendRunEvent so the run ledger is hash-chained
 * and locked. After publishing the report, the tool dispatches
 * the task-reviewer child session so the controller does not
 * need to issue a separate ship_task_start for the reviewer.
 */

import { success, failure } from "./envelope.js";
import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { resolveGitCommonDir, opencodeShipStateDir } from "../state/git-common-dir.js";
import { publishImmutableJson } from "../state/durable-store.js";
import { appendRunEvent, readRunState, RUN_EVENT_KINDS } from "../workflow/run-controller.js";
import { isSetupComplete, readLock } from "../installer/lock.js";
import { authorizeChildCall, dispatchWorker, ROLES, readControllerLease } from "../runtime/opencode-dispatcher.js";
import { resolveModelRoles } from "../installer/engineering-config.js";
import { readPlanRevision } from "../workflow/plan-store.js";
import { resolveWorkflowWorktree } from "../workflow/worktree-resolver.js";

const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function createTaskReportTool(deps) {
  return async function taskReport(input) {
    const opId = input.operationId ?? `task-report-${Date.now().toString(36)}`;
    const workflowId = String(input.workflowId ?? "");
    const taskId = String(input.taskId ?? "");
    const round = Number(input.round ?? 1);
    const summary = String(input.summary ?? "");
    if (!workflowId || !SAFE_ID_RE.test(workflowId)) {
      return failure("task-report", "workflowId required (safe id)", { operationId: opId, retryable: false });
    }
    if (!taskId || !SAFE_ID_RE.test(taskId)) {
      return failure("task-report", "taskId required (safe id)", { operationId: opId, retryable: false });
    }
    if (!Number.isInteger(round) || round <= 0) {
      return failure("task-report", "round must be a positive integer", { operationId: opId, retryable: false });
    }
    if (!summary) return failure("task-report", "summary required", { operationId: opId, retryable: false });
    const ctx = input.ctx ?? deps.ctx ?? null;
    const auth = await authorizeChildCall(
      deps.repoRoot,
      workflowId,
      ROLES.BUILDER,
      { taskId, round },
      ctx,
    );
    if (!auth.ok) {
      return failure("task-report", `builder authorization failed: ${auth.message}`, { operationId: opId, retryable: false });
    }
    const lock = await readLock(deps.repoRoot);
    if (!isSetupComplete(lock)) {
      return failure("task-report", "setup is not complete; run /setup-ship-workflow first", { operationId: opId, retryable: false });
    }
    let runState;
    try {
      runState = await readRunState(deps.repoRoot, workflowId);
    } catch (err) {
      return failure("task-report", `run state unreadable: ${err?.message ?? err}`, { operationId: opId, retryable: false });
    }
    if (!runState) {
      return failure("task-report", "run not started", { operationId: opId, retryable: false });
    }
    if (runState.activeTask !== null && runState.activeTask !== taskId) {
      return failure("task-report", `another task is already active (${runState.activeTask})`, { operationId: opId, retryable: false });
    }
    try {
      const resolved = await resolveWorkflowWorktree(deps.repoRoot, workflowId);
      if (!resolved.ok) {
        return failure("task-report", `workflow worktree resolution failed: ${resolved.kind}`, {
          operationId: opId,
          retryable: false,
          details: resolved,
        });
      }
      const commonDir = await resolveGitCommonDir(deps.repoRoot);
      const reportDir = join(opencodeShipStateDir(commonDir), "runs", workflowId, "tasks", taskId, "rounds", `${String(round).padStart(4, "0")}`);
      await mkdir(reportDir, { recursive: true });
      const record = {
        workflowId,
        taskId,
        round,
        builderSessionID: auth.sessionID,
        summary,
        changes: Array.isArray(input.changes) ? input.changes : [],
        tests: Array.isArray(input.tests) ? input.tests : [],
        submittedAt: new Date().toISOString(),
      };
      const reportPath = join(reportDir, "implementer-report.json");
      let state = runState;
      let event = runState.events.at(-1) ?? { sequence: 0 };
      let persistedRecord = record;
      if (existsSync(reportPath)) {
        persistedRecord = JSON.parse(await readFile(reportPath, "utf8"));
        if (!sameReport(persistedRecord, record)) {
          return failure("task-report", "immutable report already exists with different content", { operationId: opId, retryable: false });
        }
      } else {
        await publishImmutableJson(reportPath, record);
      }
      const persistedReportHash = reportHash(persistedRecord);
      if (!runState.events.some((candidate) => candidate.kind === RUN_EVENT_KINDS.TASK_REPORT && candidate.data?.reportHash === persistedReportHash)) {
        ({ state, event } = await appendRunEvent(
          deps.repoRoot,
          workflowId,
          runState,
          {
            kind: RUN_EVENT_KINDS.TASK_REPORT,
            data: { taskId, round, summary, reportHash: persistedReportHash, sessionID: auth.sessionID },
          },
        ));
      }
      // Auto-dispatch the task-reviewer child session so the
      // controller can issue ship_task_review next. The dispatch
      // is keyed by the same task + round so the reviewer's
      // session id is bound to this report. The parent session is
      // the controller (which owns the lease), not the builder.
      const lease = await readControllerLease(deps.repoRoot, workflowId);
      const parentSessionID = lease?.controllerSessionID
        ?? deps.controllerSessionID
        ?? input.ctx?.sessionID
        ?? null;
      const models = resolveModelRoles(deps.config?.workflow, { strict: true });
      const planRecord = await readPlanRevision(deps.repoRoot, workflowId, runState.revision);
      const task = planRecord?.plan?.tasks?.find((candidate) => candidate.id === taskId);
      if (!task) {
        return failure("task-report", `task ${taskId} is missing from the approved plan`, { operationId: opId, retryable: false });
      }
      let reviewerDispatch = null;
      if (deps.opencodeClient) {
        try {
          reviewerDispatch = await dispatchWorker({
            repoRoot: resolved.worktreePath,
            workflowId,
            role: ROLES.TASK_REVIEWER,
            keyInput: { taskId, round },
            payload: {
              promptText: [
                `Review workflow ${workflowId} task ${taskId} round ${round}.`,
                `Call ship_task_review with workflowId=${workflowId}, taskId=${taskId}, and round=${round}.`,
                `Approved task brief:\n${JSON.stringify(task, null, 2)}`,
                `Implementer report (${reportPath}):\n${JSON.stringify(persistedRecord, null, 2)}`,
              ].join("\n\n"),
            },
            client: deps.opencodeClient,
            parentSessionID,
            titleMarker: `ship-task-reviewer-${workflowId}-${taskId}-${round}`,
            agent: "ship-task-reviewer",
            model: models.builder,
          });
        } catch (err) {
          // Reviewer dispatch is best-effort. If it fails the
          // controller can retry ship_task_start.
          reviewerDispatch = { sessionID: null, dispatchKey: null, error: err?.message ?? String(err) };
        }
      }
      return success("task-report", {
        workflowId,
        taskId,
        round,
        builderSessionID: auth.sessionID,
        reviewerSessionID: reviewerDispatch?.sessionID ?? null,
        reviewerDispatchKey: reviewerDispatch?.dispatchKey ?? null,
        reviewerDispatchError: reviewerDispatch && "error" in reviewerDispatch ? reviewerDispatch.error : null,
        state: state.state,
        sequence: event.sequence,
      }, { operationId: opId });
    } catch (err) {
      return failure("task-report", String(err?.message ?? err), { operationId: opId, retryable: true });
    }
  };
}

function reportHash(record) {
  const sorted = Object.keys(record).sort();
  const ordered = {};
  for (const k of sorted) ordered[k] = record[k];
  return createHash("sha256").update(JSON.stringify(ordered), "utf8").digest("hex");
}

function sameReport(left, right) {
  for (const field of ["workflowId", "taskId", "round", "builderSessionID", "summary"]) {
    if (left?.[field] !== right?.[field]) return false;
  }
  return JSON.stringify(left?.changes ?? []) === JSON.stringify(right?.changes ?? [])
    && JSON.stringify(left?.tests ?? []) === JSON.stringify(right?.tests ?? []);
}
