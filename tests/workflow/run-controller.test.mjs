/*
 * Run reducer + controller tests.
 *
 * The reducer is pure; the controller wraps it with the I/O
 * that persists the event in the durable ledger. These tests
 * prove the state machine is deterministic and that the
 * third-failure transition requests a plan revision.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  createInitialState,
  reduce,
  appendRunEvent,
  readRunState,
  buildCommitTrailers,
  RUN_STATES,
  RUN_EVENT_KINDS,
  RUN_MAX_FIX_ROUNDS,
} from "../../src/workflow/run-controller.js";

async function makeRepo() {
  const dir = await mkdtemp(join(tmpdir(), "run-ctrl-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@local", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@local" };
  spawnSync("git", ["init", "-b", "main"], { cwd: dir, env });
  spawnSync("git", ["config", "user.email", "t@local"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  await writeFile(join(dir, "README.md"), "# t\n");
  spawnSync("git", ["add", "README.md"], { cwd: dir, env });
  spawnSync("git", ["commit", "-m", "init"], { cwd: dir, env });
  return dir;
}

test("run reducer: created -> running -> commit-pending -> committed -> running", () => {
  let { state, event } = reduce(createInitialState("wf-1", 1, "a".repeat(64)), { kind: RUN_EVENT_KINDS.RUN_START, data: { revision: 1, sha256: "a".repeat(64) } });
  assert.equal(state.state, RUN_STATES.RUNNING);
  ({ state, event } = reduce(state, { kind: RUN_EVENT_KINDS.TASK_DISPATCH, data: { taskId: "t1", briefHash: "b".repeat(64) } }));
  assert.equal(state.activeTask, "t1");
  ({ state, event } = reduce(state, { kind: RUN_EVENT_KINDS.TASK_REVIEW, data: { taskId: "t1", verdict: "pass", reviewHash: "c".repeat(64) } }));
  assert.equal(state.state, RUN_STATES.COMMIT_PENDING);
  ({ state, event } = reduce(state, { kind: RUN_EVENT_KINDS.COMMIT, data: { commitSha: "deadbeef".repeat(10) } }));
  assert.equal(state.state, RUN_STATES.COMMITTED);
  assert.deepEqual(state.completedTasks, ["t1"]);
  ({ state, event } = reduce(state, { kind: RUN_EVENT_KINDS.TASK_COMPLETE, data: { taskId: "t1" } }));
  assert.equal(state.state, RUN_STATES.RUNNING);
  assert.equal(state.activeTask, null);
});

test("run reducer: third consecutive failure requests a plan revision", () => {
  let { state } = reduce(createInitialState("wf-1", 1, "a".repeat(64)), { kind: RUN_EVENT_KINDS.RUN_START, data: { revision: 1, sha256: "a".repeat(64) } });
  for (let i = 1; i <= RUN_MAX_FIX_ROUNDS; i++) {
    ({ state } = reduce(state, { kind: RUN_EVENT_KINDS.TASK_DISPATCH, data: { taskId: "t1", briefHash: "b".repeat(64) } }));
    ({ state } = reduce(state, { kind: RUN_EVENT_KINDS.TASK_REVIEW, data: { taskId: "t1", verdict: "fail" } }));
  }
  assert.equal(state.state, RUN_STATES.REVISION_REQUIRED);
  assert.equal(state.failures, RUN_MAX_FIX_ROUNDS);
});

test("run reducer: at most one active task", () => {
  let { state } = reduce(createInitialState("wf-1", 1, "a".repeat(64)), { kind: RUN_EVENT_KINDS.RUN_START, data: { revision: 1, sha256: "a".repeat(64) } });
  ({ state } = reduce(state, { kind: RUN_EVENT_KINDS.TASK_DISPATCH, data: { taskId: "t1", briefHash: "b".repeat(64) } }));
  assert.throws(() => reduce(state, { kind: RUN_EVENT_KINDS.TASK_DISPATCH, data: { taskId: "t2", briefHash: "c".repeat(64) } }), /another task is active/);
});

test("run reducer: blocks unrecoverable infrastructure failure", () => {
  let { state } = reduce(createInitialState("wf-1", 1, "a".repeat(64)), { kind: RUN_EVENT_KINDS.RUN_START, data: { revision: 1, sha256: "a".repeat(64) } });
  ({ state } = reduce(state, { kind: RUN_EVENT_KINDS.BLOCKED, data: { reason: "fixture network error" } }));
  assert.equal(state.state, RUN_STATES.BLOCKED);
  assert.equal(state.blockedReason, "fixture network error");
});

test("run reducer: ordered -> merged requires a ready state", () => {
  let { state } = reduce(createInitialState("wf-1", 1, "a".repeat(64)), { kind: RUN_EVENT_KINDS.RUN_START, data: { revision: 1, sha256: "a".repeat(64) } });
  assert.throws(() => reduce(state, { kind: RUN_EVENT_KINDS.MERGE, data: { mergeSha: "f".repeat(40) } }), /MERGE requires state=ready/);
});

test("run controller: appendRunEvent persists the durable ledger and snapshot", async (t) => {
  const dir = await makeRepo();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const initial = createInitialState("wf-1", 1, "a".repeat(64));
  const { state: s1 } = await appendRunEvent(dir, "wf-1", initial, { kind: RUN_EVENT_KINDS.RUN_START, data: { revision: 1, sha256: "a".repeat(64) } });
  const { state: s2 } = await appendRunEvent(dir, "wf-1", s1, { kind: RUN_EVENT_KINDS.TASK_DISPATCH, data: { taskId: "t1", briefHash: "b".repeat(64) } });
  assert.equal(s2.state, RUN_STATES.RUNNING);
  const restored = await readRunState(dir, "wf-1");
  assert.equal(restored.state, RUN_STATES.RUNNING);
  assert.equal(restored.activeTask, "t1");
  assert.equal(restored.events.length, 2);
});

test("run controller: events are append-only and ordered", async (t) => {
  const dir = await makeRepo();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  let state = createInitialState("wf-1", 1, "a".repeat(64));
  ({ state } = await appendRunEvent(dir, "wf-1", state, { kind: RUN_EVENT_KINDS.RUN_START, data: { revision: 1, sha256: "a".repeat(64) } }));
  ({ state } = await appendRunEvent(dir, "wf-1", state, { kind: RUN_EVENT_KINDS.TASK_DISPATCH, data: { taskId: "t1", briefHash: "b".repeat(64) } }));
  ({ state } = await appendRunEvent(dir, "wf-1", state, { kind: RUN_EVENT_KINDS.TASK_REVIEW, data: { taskId: "t1", verdict: "pass", reviewHash: "c".repeat(64) } }));
  const restored = await readRunState(dir, "wf-1");
  assert.deepEqual(restored.events.map((e) => e.kind), [
    RUN_EVENT_KINDS.RUN_START,
    RUN_EVENT_KINDS.TASK_DISPATCH,
    RUN_EVENT_KINDS.TASK_REVIEW,
  ]);
  assert.deepEqual(restored.events.map((e) => e.sequence), [1, 2, 3]);
  assert.ok(restored.events.every((event) => /^[0-9a-f]{64}$/.test(event.hash)));
  assert.equal(restored.events[1].priorHash, restored.events[0].hash);
});

test("run controller: readRunState rejects a snapshot that disagrees with the immutable ledger", async (t) => {
  const dir = await makeRepo();
  t.after(async () => rm(dir, { recursive: true, force: true }));
  let state = createInitialState("wf-tamper", 1, "a".repeat(64));
  ({ state } = await appendRunEvent(dir, "wf-tamper", state, {
    kind: RUN_EVENT_KINDS.RUN_START,
    data: { revision: 1, sha256: "a".repeat(64) },
  }));
  const runPath = join(dir, ".git", "opencode-ship", "runs", "wf-tamper", "run.json");
  const snapshot = JSON.parse(await readFile(runPath, "utf8"));
  snapshot.state = "ready-pending";
  snapshot.finalReview = {
    standards: { verdict: "pass" },
    spec: { verdict: "pass" },
  };
  await writeFile(runPath, JSON.stringify(snapshot, null, 2));
  await assert.rejects(() => readRunState(dir, "wf-tamper"), /snapshot does not match immutable event ledger/);
});

test("commit trailers: encode workflow, plan, task, review, round", () => {
  const trailers = buildCommitTrailers({
    workflowId: "wf-2",
    planHash: "p".repeat(64),
    taskId: "t1",
    round: 2,
    reviewHash: "r".repeat(64),
  });
  assert.equal(trailers.length, 5);
  assert.match(trailers[0], /^Opencode-Ship-Workflow: wf-2$/);
  assert.match(trailers[3], /^Opencode-Ship-Review: r{64}$/);
  assert.match(trailers[4], /^Opencode-Ship-Round: 2$/);
});
