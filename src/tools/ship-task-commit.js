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
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveGitCommonDir, opencodeShipStateDir } from "../state/git-common-dir.js";
import { publishImmutableJson } from "../state/durable-store.js";
import { appendRunEvent, readRunState, RUN_EVENT_KINDS, buildCommitTrailers } from "../workflow/run-controller.js";
import { readLock, isSetupComplete } from "../installer/lock.js";

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
    if (!reviewHash) {
      return failure("task-commit", "reviewHash required (from ship_task_review)", { operationId: opId, retryable: false });
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
    if (runState.activeTask !== taskId) {
      return failure("task-commit", `no active task ${taskId} (active=${runState.activeTask})`, { operationId: opId, retryable: false });
    }
    if (runState.state !== "commit-pending") {
      return failure("task-commit", `task-review must pass before commit; run state=${runState.state}`, { operationId: opId, retryable: false });
    }
    try {
      const actualHead = (await spawn("git", ["-C", deps.repoRoot, "rev-parse", "HEAD"], deps.repoRoot)).trim();
      if (actualHead !== expectedHead) {
        return failure("task-commit", `HEAD drift (expected ${expectedHead.slice(0, 8)}, got ${actualHead.slice(0, 8)})`, { operationId: opId, retryable: false });
      }
      const trailers = buildCommitTrailers({ workflowId, planHash, taskId, round, reviewHash });
      const message = await spawn("git", ["-C", deps.repoRoot, "log", "-1", "--format=%B", expectedHead], deps.repoRoot);
      const trailerLines = trailers.map((t) => `  ${t}`).join("\n");
      if (!message.includes(trailers[0])) {
        return failure("task-commit", `commit ${expectedHead.slice(0, 8)} missing Opencode-Ship-Workflow trailer`, { operationId: opId, retryable: false });
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
      await publishImmutableJson(join(commitDir, "commit.json"), record);
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
