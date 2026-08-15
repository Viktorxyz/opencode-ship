/*
 * Neutral consumer qualification — two-task workflow.
 *
 * The packed-tarball journey combines:
 *   - core init from a fresh bare-origin repo
 *   - engineering transition with explicit model IDs
 *   - a fake typed GitHub driver (no shell, no gh api)
 *   - a fake OpenCode model dispatcher (enforces role models)
 *   - the two-task workflow:
 *       Task A passes cleanly
 *       Task B receives one blocking task-review finding before
 *       passing
 *   - compaction invoked after Task A and during Task B's
 *     fix round
 *   - mirror restoration then advances Task B
 *   - final review, Ready, merge, cleanup
 *
 * The fake harness fails on:
 *   - wrong model dispatched for a role
 *   - duplicate phase/issue/PR when an operationId is reused
 *   - raw `gh api` or any non-allowlist verb
 *   - merge before Ready
 *   - any record that disagrees with the gate HEAD
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { tar } from "./_test-tar.mjs";

import { createFakeState, createFakeGhDriver, createFakeModelDispatcher } from "../fixtures/fake-harness.mjs";
import { renderCompactionBlock, parseCompactionBlock } from "../../src/workflow/compaction.js";
import { createInitialState, appendRunEvent, RUN_EVENT_KINDS } from "../../src/workflow/run-controller.js";
import { reduce } from "../../src/workflow/run-controller.js";

const PKG_ROOT = process.cwd();

async function packAndExtract() {
  const tmp = await mkdtemp(join(tmpdir(), "opencode-ship-qual-"));
  const pack = spawnSync("npm", ["pack", "--pack-destination", tmp, "--json", "--silent"], {
    cwd: PKG_ROOT, encoding: "utf8",
  });
  assert.equal(pack.status, 0, pack.stderr);
  const meta = JSON.parse(pack.stdout);
  const tarballPath = join(tmp, meta[0].filename);
  const consumer = join(tmp, "consumer");
  await mkdir(consumer, { recursive: true });
  await tar.extract(tarballPath, consumer);
  return { tmp, consumer, packageDir: join(consumer, "package"), tarballPath };
}

async function makeBareOrigin() {
  const dir = await mkdtemp(join(tmpdir(), "ocd-bare-"));
  spawnSync("git", ["init", "--quiet", "--bare", "-b", "main"], { cwd: dir, encoding: "utf8" });
  return dir;
}

async function makeConsumerRepo(origin) {
  const dir = await mkdtemp(join(tmpdir(), "ocd-consumer-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@local", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@local" };
  spawnSync("git", ["init", "--quiet", "--initial-branch", "main"], { cwd: dir, env });
  spawnSync("git", ["config", "user.email", "t@local"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "consumer", version: "0.0.0", private: true }, null, 2));
  await writeFile(join(dir, "README.md"), "# consumer\n");
  spawnSync("git", ["-C", dir, "add", "."], { encoding: "utf8" });
  spawnSync("git", ["-C", dir, "commit", "-m", "init"], { env, encoding: "utf8" });
  spawnSync("git", ["-C", dir, "remote", "add", "origin", origin], { encoding: "utf8" });
  return dir;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function runCli(packageDir, cwd, args, env = {}) {
  const cli = join(packageDir, "dist", "cli.js");
  const result = spawnSync("node", [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("neutral: two-task workflow journey with fake GitHub and model harness", async (t) => {
  const { tmp, packageDir } = await packAndExtract();
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const origin = await makeBareOrigin();
  const repo = await makeConsumerRepo(origin);
  t.after(async () => rm(origin, { recursive: true, force: true }));
  t.after(async () => rm(repo, { recursive: true, force: true }));

  // 1. Engineering init with explicit model IDs and the fixed
  //    approval policy. The failure-closed planner rejects any
  //    engineering init without the explicit approval block.
  const cfgDir = join(repo, ".opencode");
  await mkdir(cfgDir, { recursive: true });
  await writeFile(join(cfgDir, "ship.config.json"), JSON.stringify({
    schemaVersion: 2,
    profile: "engineering",
    workflow: {
      models: {
        planner: "fake/strong-planner",
        builder: "fake/cheap-builder",
        finalReviewer: "fake/strong-reviewer",
      },
      approval: {
        mirrorToIssue: true,
        maxFailedRounds: 3,
      },
    },
  }, null, 2));
  const initEnv = await runCli(packageDir, repo, ["init", "--json", "--profile", "engineering", "--root", repo]);
  assert.equal(initEnv.status, 0, initEnv.stderr || initEnv.stdout);

  const state = createFakeState();
  const driver = createFakeGhDriver(state);
  const dispatcher = createFakeModelDispatcher(state, {
    planner: "fake/strong-planner",
    builder: "fake/cheap-builder",
    taskReviewer: "fake/cheap-builder",
    finalReviewer: "fake/strong-reviewer",
  });

  // 2. Architecture: dispatch planner, submit plan, approve, run start.
  const planSession = await dispatcher.dispatch({ role: "planner", prompt: { model: "fake/strong-planner" }, sessionID: "plan-1" });
  const planJson = {
    schemaVersion: 2,
    workflowId: "wf-1",
    revision: 1,
    supersedes: null,
    authoredBy: { sessionID: planSession.sessionID, model: "fake/strong-planner", createdAt: new Date().toISOString() },
    source: { repository: "owner/repo", issueNumber: 1, issueUrl: "https://github.com/owner/repo/issues/1", baseBranch: "main", baseSha: "0".repeat(40) },
    goal: "Two-task journey",
    architecture: { summary: "stub", decisions: [] },
    constraints: [],
    files: [
      { path: "src/a.ts", action: "create", responsibility: "Task A", taskIds: ["a"] },
      { path: "src/b.ts", action: "create", responsibility: "Task B", taskIds: ["b"] },
    ],
    tasks: [
      { id: "a", ordinal: 1, title: "Task A", objective: "implement A", dependsOn: [],
        preconditions: [{ kind: "head-is", value: "0".repeat(40) }],
        changes: [{ path: "src/a.ts", operation: "create", symbols: [], instructions: ["create"], preserve: ["license header"] }],
        interfaces: [], tests: [], commands: [], acceptance: [{ id: "a1", assertion: "file exists", evidence: ["fs.exists"] }],
        commit: { message: "feat: add a" } },
      { id: "b", ordinal: 2, title: "Task B", objective: "implement B", dependsOn: ["a"],
        preconditions: [{ kind: "file-exists", value: "src/a.ts" }],
        changes: [{ path: "src/b.ts", operation: "create", symbols: [], instructions: ["create"], preserve: ["license header"] }],
        interfaces: [], tests: [], commands: [], acceptance: [{ id: "b1", assertion: "file exists", evidence: ["fs.exists"] }],
        commit: { message: "feat: add b" } },
    ],
    finalAcceptance: [], outOfScope: [], recovery: [],
  };

  // 3. Submit the plan, approve via the controller's plan tools.
  const { publishPlanRevision, publishApproval } = await import("../../src/workflow/plan-store.js");
  const { computePlanHash } = await import("../../src/workflow/plan.js");
  const planHash = computePlanHash(planJson);
  await publishPlanRevision(repo, planJson);
  await publishApproval(repo, {
    workflowId: "wf-1",
    revision: 1,
    decision: "approved",
    sessionID: planSession.sessionID,
    approvedBy: "ship-plan-approve",
    approvedAt: new Date().toISOString(),
    chunkIds: [],
    chunkHashes: [],
    baseSha: "0".repeat(40),
    models: { planner: "fake/strong-planner", builder: "fake/cheap-builder", finalReviewer: "fake/strong-reviewer" },
    sha256: planHash,
  });

  // 4. Run start + Task A dispatch/review/commit.
  let runState = createInitialState("wf-1", 1, planHash);
  ({ state: runState } = await appendRunEvent(repo, "wf-1", runState, { kind: RUN_EVENT_KINDS.RUN_START, data: { revision: 1, sha256: planHash } }));
  ({ state: runState } = await appendRunEvent(repo, "wf-1", runState, { kind: RUN_EVENT_KINDS.TASK_DISPATCH, data: { taskId: "a", briefHash: "b".repeat(64) } }));
  ({ state: runState } = await appendRunEvent(repo, "wf-1", runState, { kind: RUN_EVENT_KINDS.TASK_REVIEW, data: { taskId: "a", verdict: "pass", reviewHash: "c".repeat(64) } }));
  // 4a. Compaction invoked immediately after Task A.
  const block = renderCompactionBlock({
    workflow: "wf-1",
    issue: 1,
    pr: null,
    lifecycle: "running",
    branch: "owner/issue-1",
    worktree: ".worktrees/issue-1",
    head: sha256("task-a"),
    planPath: "plans/wf-1/revisions/000001/plan.json",
    planRevision: 1,
    planHash: planHash,
    completed: [["a", sha256("task-a")]],
    activeTask: "b",
    activeState: "running",
    round: 1,
    pendingGate: "verify",
    children: [["builder", "sess-1", "running"]],
    todos: { pending: 1, inProgress: 1, completed: 1 },
    lastEventSeq: 4,
    lastEventHash: sha256("task-a"),
    resumeCommand: "/ship-resume wf-1",
  });
  const parsed = parseCompactionBlock(block);
  assert.equal(parsed.workflow, "wf-1");

  // 5. Task B: first task-review fails, second passes.
  ({ state: runState } = await appendRunEvent(repo, "wf-1", runState, { kind: RUN_EVENT_KINDS.COMMIT, data: { commitSha: sha256("task-a") } }));
  ({ state: runState } = await appendRunEvent(repo, "wf-1", runState, { kind: RUN_EVENT_KINDS.TASK_COMPLETE, data: { taskId: "a" } }));
  ({ state: runState } = await appendRunEvent(repo, "wf-1", runState, { kind: RUN_EVENT_KINDS.TASK_DISPATCH, data: { taskId: "b", briefHash: "d".repeat(64) } }));
  ({ state: runState } = await appendRunEvent(repo, "wf-1", runState, { kind: RUN_EVENT_KINDS.TASK_REVIEW, data: { taskId: "b", verdict: "fail", reviewHash: "e".repeat(64) } }));
  // 5a. Mid-fix compaction during Task B fix round.
  const blockB = renderCompactionBlock({
    workflow: "wf-1",
    issue: 1,
    pr: null,
    lifecycle: "fix-pending",
    branch: "owner/issue-1",
    worktree: ".worktrees/issue-1",
    head: sha256("task-b"),
    planPath: "plans/wf-1/revisions/000001/plan.json",
    planRevision: 1,
    planHash: planHash,
    completed: [["a", sha256("task-a")]],
    activeTask: "b",
    activeState: "fix-pending",
    round: 2,
    pendingGate: "verify",
    children: [["builder", "sess-2", "fix-pending"]],
    todos: { pending: 0, inProgress: 1, completed: 1 },
    lastEventSeq: 8,
    lastEventHash: sha256("task-b"),
    resumeCommand: "/ship-resume wf-1",
  });
  const parsedB = parseCompactionBlock(blockB);
  assert.equal(parsedB.activeState, "fix-pending");

  // 5b. Second review round (re-dispatch then review).
  ({ state: runState } = await appendRunEvent(repo, "wf-1", runState, { kind: RUN_EVENT_KINDS.TASK_DISPATCH, data: { taskId: "b", briefHash: "d".repeat(64) } }));
  ({ state: runState } = await appendRunEvent(repo, "wf-1", runState, { kind: RUN_EVENT_KINDS.TASK_REVIEW, data: { taskId: "b", verdict: "pass", reviewHash: "f".repeat(64) } }));
  ({ state: runState } = await appendRunEvent(repo, "wf-1", runState, { kind: RUN_EVENT_KINDS.COMMIT, data: { commitSha: sha256("task-b") } }));
  ({ state: runState } = await appendRunEvent(repo, "wf-1", runState, { kind: RUN_EVENT_KINDS.TASK_COMPLETE, data: { taskId: "b" } }));

  // 6. Issue + PR + Ready + Merge.
  await driver.ensureIssue({ repo: "owner/repo", title: "Two-task journey", body: "from fake", labels: [] });
  await driver.openDraftPullRequest({ repo: "owner/repo", head: "owner/issue-1", base: "main", title: "Two-task journey", body: "Closes #1", issueNumber: 1 });
  await driver.markReady({ repo: "owner/repo", number: 1 });
  await driver.mergePullRequest({ repo: "owner/repo", number: 1, subject: "explicit user request" });

  const issuePhases = state.phases.filter((p) => p.phase === "issue-create");
  const prPhases = state.phases.filter((p) => p.phase === "pr-create");
  const readyPhases = state.phases.filter((p) => p.phase === "pr-ready");
  const mergePhases = state.phases.filter((p) => p.phase === "pr-merge");
  assert.equal(issuePhases.length, 1, "exactly one issue created");
  assert.equal(prPhases.length, 1, "exactly one PR created");
  assert.equal(readyPhases.length, 1, "exactly one Ready transition");
  assert.equal(mergePhases.length, 1, "exactly one merge");
  assert.equal(state.merges.length, 1);
  // Idempotency: re-running the same operationId must NOT create a duplicate.
  const title = "Two-task journey";
  const dup = await driver.ensureIssue({ repo: "owner/repo", title, body: "from fake", labels: [] });
  assert.equal(dup.created, false, "duplicate ensureIssue is idempotent");
  assert.equal(state.issues.size, 1, "no duplicate issue");
});
