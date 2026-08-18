/*
 * Resume + compaction tests.
 *
 * The resume path is concurrency-safe (per-run lock) and
 * crash-recoverable (reconstruct from trailer history). The
 * compaction block is bounded by 4 KiB and pointer-only.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  resumeRun,
  reconcileCrashAfterCommit,
  hydratePlanFromMirror,
} from "../../src/workflow/resume.js";
import { renderCompactionBlock, parseCompactionBlock, hashCompactionBlock, COMPACTION_MAX_BYTES } from "../../src/workflow/compaction.js";
import { createInitialState, appendRunEvent, RUN_EVENT_KINDS } from "../../src/workflow/run-controller.js";
import { issueControllerLease, readControllerLease } from "../../src/runtime/opencode-dispatcher.js";
import { createResumeTool } from "../../src/tools/ship-resume.js";

async function makeRepo() {
  const dir = await mkdtemp(join(tmpdir(), "resume-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@local", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@local" };
  spawnSync("git", ["init", "-b", "main"], { cwd: dir, env });
  spawnSync("git", ["config", "user.email", "t@local"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  await writeFile(join(dir, "README.md"), "# t\n");
  spawnSync("git", ["add", "README.md"], { cwd: dir, env });
  spawnSync("git", ["commit", "-m", "init"], { cwd: dir, env });
  return dir;
}

const SAMPLE_PLAN = {
  schemaVersion: 2,
  workflowId: "wf-resume",
  revision: 1,
  supersedes: null,
  authoredBy: { sessionID: "sess-1", model: "openai/gpt-5.6-sol", createdAt: new Date().toISOString() },
  source: { repository: "owner/repo", issueNumber: 7, issueUrl: "https://github.com/owner/repo/issues/7", baseBranch: "main", baseSha: "0".repeat(40) },
  goal: "Resume this workflow from durable state.",
  architecture: { summary: "test", decisions: [] },
  constraints: [],
  files: [{ path: "src/example.ts", action: "create", responsibility: "skeleton", taskIds: ["t1"] }],
  tasks: [{
    id: "t1", ordinal: 1, title: "First task", objective: "establish skeleton", dependsOn: [],
    preconditions: [{ kind: "head-is", value: "0".repeat(40) }],
    changes: [{ path: "src/example.ts", operation: "create", symbols: [], instructions: ["scaffold"], preserve: ["license header"] }],
    interfaces: [], tests: [], commands: [], acceptance: [{ id: "a1", assertion: "file exists", evidence: ["fs.exists"] }],
    commit: { message: "feat: add example" },
  }],
  finalAcceptance: [], outOfScope: [], recovery: [],
};

test("compaction block: round-trips through parse and hash", () => {
  const block = {
    workflow: "wf-1",
    issue: 7,
    pr: null,
    lifecycle: "running",
    branch: "owner/issue-7",
    worktree: ".worktrees/issue-7",
    head: "a".repeat(40),
    planPath: "plans/wf-1/revisions/000001/plan.json",
    planRevision: 1,
    planHash: "p".repeat(64),
    completed: [["t1", "c".repeat(40)]],
    activeTask: "t2",
    activeState: "running",
    round: 2,
    pendingGate: "verify",
    children: [["builder", "sess-1", "running"]],
    todos: { pending: 1, inProgress: 1, completed: 1 },
    lastEventSeq: 5,
    lastEventHash: "e".repeat(64),
    resumeCommand: "/ship-resume wf-1",
  };
  const text = renderCompactionBlock(block);
  assert.ok(Buffer.byteLength(text, "utf8") <= COMPACTION_MAX_BYTES);
  const parsed = parseCompactionBlock(text);
  assert.equal(parsed.workflow, "wf-1");
  assert.equal(parsed.activeTask, "t2");
  assert.equal(parsed.todos.completed, 1);
  assert.match(hashCompactionBlock(text), /^[0-9a-f]{64}$/);
});

test("compaction block: rejects payloads exceeding the 4 KiB budget", () => {
  const oversize = {
    workflow: "wf-1",
    issue: 1,
    pr: null,
    lifecycle: "running",
    branch: "owner/issue-1",
    worktree: ".worktrees/issue-1",
    head: "a".repeat(40),
    planPath: "plans/wf-1/revisions/000001/plan.json",
    planRevision: 1,
    planHash: "p".repeat(64),
    completed: Array.from({ length: 500 }, (_, i) => [`t${i}`, "c".repeat(40)]),
    activeTask: null,
    activeState: "running",
    round: 0,
    pendingGate: "verify",
    children: [],
    todos: { pending: 0, inProgress: 0, completed: 0 },
    lastEventSeq: 1,
    lastEventHash: "e".repeat(64),
    resumeCommand: "/ship-resume wf-1",
  };
  assert.throws(() => renderCompactionBlock(oversize), /4 KiB|4096/);
});

test("resume: returns the next action for a running workflow", async (t) => {
  const dir = await makeRepo();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  let state = createInitialState("wf-resume-1", 1, "a".repeat(64));
  ({ state } = await appendRunEvent(dir, "wf-resume-1", state, { kind: RUN_EVENT_KINDS.RUN_START, data: { revision: 1, sha256: "a".repeat(64) } }));
  const { nextAction } = await resumeRun(dir, "wf-resume-1");
  assert.equal(nextAction, "task-report");
});

test("resume: hydrates the plan from a verified mirror chunk", async (t) => {
  const dir = await makeRepo();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const { canonicalize, computePlanHash } = await import("../../src/workflow/plan.js");
  const expectedHash = computePlanHash(SAMPLE_PLAN);
  const canonical = canonicalize(SAMPLE_PLAN);
  const chunks = [canonical];
  const r = await hydratePlanFromMirror(dir, "wf-resume-2", 1, { chunks, expectedHash });
  assert.equal(r.hash, expectedHash);
  const { resumeRun } = await import("../../src/workflow/resume.js");
  const { nextAction } = await resumeRun(dir, "wf-resume-2");
  assert.equal(nextAction, "run-start");
});

test("resume: crash reconciliation seals commit-pending as committed", async (t) => {
  const dir = await makeRepo();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  let state = createInitialState("wf-resume-3", 1, "a".repeat(64));
  ({ state } = await appendRunEvent(dir, "wf-resume-3", state, { kind: RUN_EVENT_KINDS.RUN_START, data: { revision: 1, sha256: "a".repeat(64) } }));
  ({ state } = await appendRunEvent(dir, "wf-resume-3", state, { kind: RUN_EVENT_KINDS.TASK_DISPATCH, data: { taskId: "t1", briefHash: "b".repeat(64) } }));
  ({ state } = await appendRunEvent(dir, "wf-resume-3", state, { kind: RUN_EVENT_KINDS.TASK_REVIEW, data: { taskId: "t1", verdict: "pass", reviewHash: "c".repeat(64) } }));
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
  const r = await reconcileCrashAfterCommit(dir, "wf-resume-3", head);
  assert.equal(r.reconciled, true);
  const { nextAction } = await resumeRun(dir, "wf-resume-3");
  assert.equal(nextAction, "task-complete");
});

test("resume: two concurrent resumes serialise on the per-run lock", async (t) => {
  const dir = await makeRepo();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  let state = createInitialState("wf-resume-4", 1, "a".repeat(64));
  ({ state } = await appendRunEvent(dir, "wf-resume-4", state, { kind: RUN_EVENT_KINDS.RUN_START, data: { revision: 1, sha256: "a".repeat(64) } }));
  const [a, b] = await Promise.all([resumeRun(dir, "wf-resume-4"), resumeRun(dir, "wf-resume-4")]);
  assert.equal(a.nextAction, b.nextAction);
});

test("ship_resume transfers the controller lease to the current controller session", async (t) => {
  const dir = await makeRepo();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  let state = createInitialState("wf-resume-lease", 1, "a".repeat(64));
  ({ state } = await appendRunEvent(dir, "wf-resume-lease", state, {
    kind: RUN_EVENT_KINDS.RUN_START,
    data: { revision: 1, sha256: "a".repeat(64) },
  }));
  await issueControllerLease(dir, "wf-resume-lease", "controller-old");
  const tool = createResumeTool({
    repoRoot: dir,
    ctx: { sessionID: "controller-new", agent: "ship-controller" },
  });
  const result = await tool({ workflowId: "wf-resume-lease" });
  assert.equal(result.ok, true, result.message);
  assert.equal((await readControllerLease(dir, "wf-resume-lease")).controllerSessionID, "controller-new");
});
