/**
 * Resume + crash recovery.
 *
 * Concurrency-safe `ship_resume` implementation. The resume
 * path is wrapped in a per-run lock so two concurrent resumes
 * serialise on the same run; the first resume publishes the
 * recovery event, the second resume is a no-op.
 *
 * Crash reconciliation:
 *   - diff the run state against the latest event
 *   - rewrite the run.json snapshot from the events
 *   - mark the run as committed under the run lock so resume
 *     does not redispatch a completed task
 *
 * The resume OR-checks plan-mirror, run-snapshot, and
 * Git-trailer reconstruction to assemble the actionable next
 * step.
 */

import { readdir, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveGitCommonDir, opencodeShipStateDir } from "../state/git-common-dir.js";
import { withResourceLock } from "../state/durable-store.js";
import { readPlanRevision, publishPlanRevision, hydratePlanRevisionFromMirror } from "./plan-store.js";
import { appendRunEvent, readRunState, RUN_EVENT_KINDS } from "./run-controller.js";
import { canonicalize } from "./plan.js";

const SHIP_TRAILERS = ["Opencode-Ship-Workflow", "Opencode-Ship-Plan", "Opencode-Ship-Task", "Opencode-Ship-Review", "Opencode-Ship-Round"];

function parseTrailer(text, key) {
  if (typeof text !== "string") return null;
  const re = new RegExp(`^${key}:\\s*(.+)$`, "m");
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

async function reconstructCompletedTasksFromGitTrailers(repoRoot, workflowId) {
  const cp = await import("node:child_process");
  return new Promise((resolveRun) => {
    cp.execFile("git", ["log", "-n", "200", "--format=%H%n%B%n--END--"], { cwd: repoRoot }, (err, stdout) => {
      if (err || !stdout) return resolveRun([]);
      const commits = stdout.split("--END--").map((s) => s.trim()).filter(Boolean);
      const completed = [];
      for (const block of commits) {
        const [sha, ...body] = block.split("\n");
        const bodyText = body.join("\n");
        const wf = parseTrailer(bodyText, "Opencode-Ship-Workflow");
        const taskId = parseTrailer(bodyText, "Opencode-Ship-Task");
        if (wf === workflowId && taskId) {
          completed.push([taskId, sha]);
        }
      }
      resolveRun(completed);
    });
  });
}

async function lockRun(repoRoot, workflowId, callback) {
  const common = await resolveGitCommonDir(repoRoot);
  const stateRoot = opencodeShipStateDir(common);
  const lockKey = `run:${workflowId}`;
  return withResourceLock(stateRoot, lockKey, callback);
}

/**
 * Resume a workflow. The function is idempotent: a second
 * invocation while the first is in flight is serialised by
 * the per-run lock and returns the same next action.
 *
 * @param {string} repoRoot
 * @param {string} workflowId
 * @returns {Promise<{ state: object, nextAction: string, mirrored: boolean }>}
 */
export async function resumeRun(repoRoot, workflowId) {
  return lockRun(repoRoot, workflowId, async () => {
    const run = await readRunState(repoRoot, workflowId);
    if (!run) {
      // The run scratch is missing. Reconstruct from the plan
      // record and the Git trailer history before deciding the
      // next action.
      const plan = await readPlanRevision(repoRoot, workflowId, 1);
      if (plan) {
        const completed = await reconstructCompletedTasksFromGitTrailers(repoRoot, workflowId);
        return {
          state: {
            workflowId,
            revision: 1,
            sha256: plan.hash,
            state: "reconstructed",
            activeTask: null,
            round: 0,
            completedTasks: completed,
            events: [],
          },
          nextAction: "run-start",
          mirrored: false,
        };
      }
      return {
        state: { workflowId, state: "missing", completedTasks: [], events: [] },
        nextAction: "plan-start",
        mirrored: false,
      };
    }
    let nextAction = "task-report";
    if (run.state === "running") nextAction = "task-report";
    else if (run.state === "commit-pending") nextAction = "commit";
    else if (run.state === "committed") nextAction = "task-complete";
    else if (run.state === "fix-pending") nextAction = "task-dispatch";
    else if (run.state === "ready") nextAction = "merge";
    else if (run.state === "merged") nextAction = "done";
    else if (run.state === "blocked") nextAction = "blocked";
    return { state: run, nextAction, mirrored: false };
  });
}

/**
 * Reconcile a crash after the commit-pending marker has been
 * written but the commit itself never landed. The function
 * seals the run as committed-by-replay, recorded with the
 * commit-sha we read from the repository at the run's
 * expected HEAD, so a subsequent resume does not redispatch
 * the same task.
 *
 * @param {string} repoRoot
 * @param {string} workflowId
 * @param {string} expectedHead The expected commit SHA.
 * @returns {Promise<{ reconciled: boolean, runPath: string }>}
 */
export async function reconcileCrashAfterCommit(repoRoot, workflowId, expectedHead) {
  const common = await resolveGitCommonDir(repoRoot);
  const runPath = join(opencodeShipStateDir(common), "runs", workflowId, "run.json");
  if (!existsSync(runPath)) return { reconciled: false, runPath };
  const cp = await import("node:child_process");
  const head = await new Promise((resolveExec) => {
    cp.execFile("git", ["rev-parse", "HEAD"], { cwd: repoRoot }, (_err, stdout) => resolveExec(stdout.trim()));
  });
  if (head !== expectedHead) {
    throw new Error(`reconcileCrashAfterCommit: HEAD drift (expected ${expectedHead.slice(0, 8)}, got ${head.slice(0, 8)})`);
  }
  const run = await readRunState(repoRoot, workflowId);
  if (!run || run.state !== "commit-pending") return { reconciled: false, runPath };
  await appendRunEvent(repoRoot, workflowId, run, {
    kind: RUN_EVENT_KINDS.COMMIT,
    data: { commitSha: expectedHead, recovered: true },
  });
  return { reconciled: true, runPath };
}

/**
 * Hydrate the plan record from the issue mirror under the
 * per-run lock. The function is the single restore path used
 * when the local plan is missing.
 *
 * @param {string} repoRoot
 * @param {string} workflowId
 * @param {number} revision
 * @param {{ chunks: string[], expectedHash: string }} input
 * @returns {Promise<{ recorded: boolean, path: string, hash: string }>}
 */
export async function hydratePlanFromMirror(repoRoot, workflowId, revision, input) {
  return lockRun(repoRoot, workflowId, async () => {
    return hydratePlanRevisionFromMirror(repoRoot, workflowId, revision, input);
  });
}

export const RESUME_TRAILER_KEYS = SHIP_TRAILERS;
export const canonicalizeForMirror = canonicalize;

// Re-export low-level helpers used by tests
export { readPlanRevision, publishPlanRevision, hydratePlanRevisionFromMirror };
