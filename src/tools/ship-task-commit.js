/**
 * ship_task_commit tool.
 *
 * Records the immutable commit binding for an active task. The
 * caller must have already produced the commit (this tool does
 * not run `git commit`); the tool only verifies the expected
 * HEAD, the reviewed path set, and the trailers, and writes the
 * immutable commit record.
 *
 * The reducer advances the run from commit-pending to committed.
 */
import { success, failure } from "./envelope.js";
import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveGitCommonDir, opencodeShipStateDir } from "../state/git-common-dir.js";
import { publishImmutableJson } from "../state/durable-store.js";
import { appendRunEvent, readRunState, RUN_EVENT_KINDS, buildCommitTrailers } from "../workflow/run-controller.js";
import { readLock, isSetupComplete } from "../installer/lock.js";
import { authorizeControllerCall } from "../runtime/opencode-dispatcher.js";

const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

function spawn(cmd, args, cwd) {
  return new Promise((resolveP, rejectP) => {
    execFile(cmd, args, { cwd, shell: false }, (err, stdout, stderr) => {
      if (err) {
        const msg = typeof stderr === "string" ? stderr : stderr ? String(stderr) : err.message;
        return rejectP(new Error(`${cmd} failed: ${msg}`));
      }
      resolveP(typeof stdout === "string" ? stdout : String(stdout));
    });
  });
}

export function createTaskCommitTool(deps) {
  return async function taskCommit(input) {
    const opId = input.operationId ?? `task-commit-${Date.now().toString(36)}`;
    const workflowId = String(input.workflowId ?? "");
    const taskId = String(input.taskId ?? "");
    const expectedHead = String(input.expectedHead ?? "");
    const commitSha = String(input.commitSha ?? "");
    const planHash = String(input.planHash ?? "");
    const reviewHash = String(input.reviewHash ?? "");
    const round = Number(input.round ?? 1);
    if (!workflowId || !SAFE_ID_RE.test(workflowId)) {
      return failure("task-commit", "workflowId required (safe id)", { operationId: opId, retryable: false });
    }
    if (!taskId || !SAFE_ID_RE.test(taskId)) {
      return failure("task-commit", "taskId required (safe id)", { operationId: opId, retryable: false });
    }
    if (!/^[0-9a-f]{40}$/.test(expectedHead)) {
      return failure("task-commit", "expectedHead required (40-char commit SHA)", { operationId: opId, retryable: false });
    }
    if (!/^[0-9a-f]{40}$/.test(commitSha)) {
      return failure("task-commit", "commitSha required (40-char commit SHA)", { operationId: opId, retryable: false });
    }
    if (!/^[0-9a-f]{64}$/.test(planHash)) {
      return failure("task-commit", "planHash required (sha256)", { operationId: opId, retryable: false });
    }
    if (!/^[0-9a-f]{64}$/.test(reviewHash)) {
      return failure("task-commit", "reviewHash required (sha256 from ship_task_review)", { operationId: opId, retryable: false });
    }
    const ctx = input.ctx ?? deps.ctx ?? null;
    const auth = await authorizeControllerCall(deps.repoRoot, workflowId, ctx);
    if (!auth.ok) {
      return failure("task-commit", `controller authorization failed: ${auth.message}`, { operationId: opId, retryable: false });
    }
    const lock = await readLock(deps.repoRoot);
    if (!isSetupComplete(lock)) {
      return failure("task-commit", "setup is not complete; run /setup-ship-workflow first", { operationId: opId, retryable: false });
    }
    let runState;
    try {
      runState = await readRunState(deps.repoRoot, workflowId);
    } catch (err) {
      return failure("task-commit", `run state unreadable: ${err?.message ?? err}`, { operationId: opId, retryable: false });
    }
    if (!runState) {
      return failure("task-commit", "run not started", { operationId: opId, retryable: false });
    }
    const priorCommit = runState.events.find((event) => (
      event.kind === RUN_EVENT_KINDS.COMMIT
      && event.data?.taskId === taskId
      && event.data?.commitSha === commitSha
    ));
    if (priorCommit) {
      return success("task-commit", {
        workflowId,
        taskId,
        commitSha,
        state: runState.state,
        sequence: priorCommit.sequence,
      }, { operationId: opId, idempotent: true });
    }
    if (runState.activeTask !== taskId) {
      return failure("task-commit", `no active task ${taskId} (active=${runState.activeTask})`, { operationId: opId, retryable: false });
    }
    if (runState.state !== "commit-pending") {
      return failure("task-commit", `task-review must pass before commit; run state=${runState.state}`, { operationId: opId, retryable: false });
    }
    if (commitSha !== expectedHead) {
      return failure("task-commit", "commitSha must equal expectedHead", { operationId: opId, retryable: false });
    }
    if (planHash !== runState.sha256) {
      return failure("task-commit", "planHash does not match the active run", { operationId: opId, retryable: false });
    }
    if (reviewHash !== runState.taskReady?.reviewHash) {
      return failure("task-commit", "reviewHash does not match the recorded task review", { operationId: opId, retryable: false });
    }
    if (round !== runState.round) {
      return failure("task-commit", `round does not match the active run (${runState.round})`, { operationId: opId, retryable: false });
    }
    try {
      const actualHead = (await spawn("git", ["-C", deps.repoRoot, "rev-parse", "HEAD"], deps.repoRoot)).trim();
      if (actualHead !== expectedHead) {
        return failure("task-commit", `HEAD drift (expected ${expectedHead.slice(0, 8)}, got ${actualHead.slice(0, 8)})`, { operationId: opId, retryable: false });
      }
      const trailers = buildCommitTrailers({ workflowId, planHash, taskId, round, reviewHash });
      const message = await spawn("git", ["-C", deps.repoRoot, "log", "-1", "--format=%B", expectedHead], deps.repoRoot);
      const trailerLines = trailers.map((t) => `  ${t}`).join("\n");
      const missingTrailer = trailers.find((trailer) => !message.includes(trailer));
      if (missingTrailer) {
        return failure("task-commit", `commit ${expectedHead.slice(0, 8)} missing trailer: ${missingTrailer}`, { operationId: opId, retryable: false });
      }
      const commonDir = await resolveGitCommonDir(deps.repoRoot);
      const commitDir = join(opencodeShipStateDir(commonDir), "runs", workflowId, "tasks", taskId, "commit");
      await mkdir(commitDir, { recursive: true });
      const record = {
        workflowId,
        taskId,
        round,
        commitSha,
        planHash,
        reviewHash,
        trailers,
        trailerBlock: trailerLines,
        committedAt: new Date().toISOString(),
      };
      const commitPath = join(commitDir, "commit.json");
      if (existsSync(commitPath)) {
        const existing = JSON.parse(await readFile(commitPath, "utf8"));
        if (
          existing.workflowId !== workflowId
          || existing.taskId !== taskId
          || existing.round !== round
          || existing.commitSha !== commitSha
          || existing.planHash !== planHash
          || existing.reviewHash !== reviewHash
        ) {
          return failure("task-commit", "immutable task commit conflicts with retry", { operationId: opId, retryable: false });
        }
      } else {
        await publishImmutableJson(commitPath, record);
      }
      const { state, event } = await appendRunEvent(
        deps.repoRoot,
        workflowId,
        runState,
        { kind: RUN_EVENT_KINDS.COMMIT, data: { taskId, commitSha } },
      );
      return success("task-commit", { workflowId, taskId, commitSha, state: state.state, sequence: event.sequence }, { operationId: opId });
    } catch (err) {
      return failure("task-commit", String(err?.message ?? err), { operationId: opId, retryable: true });
    }
  };
}
