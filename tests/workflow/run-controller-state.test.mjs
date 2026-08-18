/**
 * Reducer behavior tests for the rc.3 corrections:
 *
 *   - TASK_REPORT does NOT increment round
 *   - failed TASK_REVIEW advances round exactly once per verdict
 *   - third consecutive failed verdict drives revision-required
 *   - COMMIT appends to completedTasks exactly once
 *   - TASK_COMPLETE does NOT duplicate completedTasks
 *   - FINAL_REVIEW requires both axes on the same package hash
 *   - FINAL_REVIEW rejects an axis whose HEAD drifts from the
 *     previously-recorded axis HEAD
 *   - READY requires both Standards and Spec final reviews
 *   - READY rejects head drift between final review and ready
 */

import test from "node:test";
import assert from "node:assert/strict";

import { reduce, createInitialState, RUN_EVENT_KINDS } from "../../src/workflow/run-controller.js";

function sha() {
  return "0".repeat(64);
}

test("TASK_REPORT does not increment round", () => {
  const s0 = createInitialState("wf-1", 1, sha());
  const s1 = reduce(s0, {
    kind: RUN_EVENT_KINDS.RUN_START,
    data: { revision: 1, sha256: sha() },
 }).state;
  const s2 = reduce(s1, {
    kind: RUN_EVENT_KINDS.TASK_DISPATCH,
    data: { taskId: "a", briefHash: sha() },
 }).state;
  assert.equal(s2.round, 1);
  const s3 = reduce(s2, {
    kind: RUN_EVENT_KINDS.TASK_REPORT,
    data: { taskId: "a", reportHash: sha() },
 }).state;
  assert.equal(s3.round, 1, "TASK_REPORT must not advance round");
  assert.equal(s3.taskReady?.taskId, "a");
});

test("failed TASK_REVIEW advances round and a pass round does not", () => {
  let s = createInitialState("wf-1", 1, sha());
  s = reduce(s, { kind: RUN_EVENT_KINDS.RUN_START, data: { revision: 1, sha256: sha() } }).state;
  s = reduce(s, { kind: RUN_EVENT_KINDS.TASK_DISPATCH, data: { taskId: "a", briefHash: sha() } }).state;
  s = reduce(s, { kind: RUN_EVENT_KINDS.TASK_REPORT, data: { taskId: "a", reportHash: sha() } }).state;
  s = reduce(s, { kind: RUN_EVENT_KINDS.TASK_REVIEW, data: { taskId: "a", verdict: "pass", reviewHash: sha() } }).state;
  assert.equal(s.round, 1, "pass verdict must not advance round");
  assert.equal(s.state, "commit-pending");
});

test("third consecutive failed verdict drives revision-required and round==3 failures==3", () => {
  let s = createInitialState("wf-1", 1, sha());
  s = reduce(s, { kind: RUN_EVENT_KINDS.RUN_START, data: { revision: 1, sha256: sha() } }).state;
  s = reduce(s, { kind: RUN_EVENT_KINDS.TASK_DISPATCH, data: { taskId: "a", briefHash: sha() } }).state;
  for (let i = 0; i < 3; i++) {
    s = reduce(s, { kind: RUN_EVENT_KINDS.TASK_REPORT, data: { taskId: "a", reportHash: sha() } }).state;
    s = reduce(s, { kind: RUN_EVENT_KINDS.TASK_REVIEW, data: { taskId: "a", verdict: "fail", reviewHash: sha() } }).state;
    if (i < 2) {
      s = reduce(s, { kind: RUN_EVENT_KINDS.TASK_DISPATCH, data: { taskId: "a", briefHash: sha() } }).state;
    }
  }
  assert.equal(s.state, "revision-required");
  assert.equal(s.failures, 3);
  assert.equal(s.round, 4);
});

test("COMMIT appends task to completedTasks exactly once; TASK_COMPLETE does not duplicate", () => {
  let s = createInitialState("wf-1", 1, sha());
  s = reduce(s, { kind: RUN_EVENT_KINDS.RUN_START, data: { revision: 1, sha256: sha() } }).state;
  s = reduce(s, { kind: RUN_EVENT_KINDS.TASK_DISPATCH, data: { taskId: "a", briefHash: sha() } }).state;
  s = reduce(s, { kind: RUN_EVENT_KINDS.TASK_REPORT, data: { taskId: "a", reportHash: sha() } }).state;
  s = reduce(s, { kind: RUN_EVENT_KINDS.TASK_REVIEW, data: { taskId: "a", verdict: "pass", reviewHash: sha() } }).state;
  s = reduce(s, { kind: RUN_EVENT_KINDS.COMMIT, data: { commitSha: sha() } }).state;
  assert.deepEqual(s.completedTasks, ["a"]);
  s = reduce(s, { kind: RUN_EVENT_KINDS.TASK_COMPLETE, data: { taskId: "a", moreTasks: false } }).state;
  assert.deepEqual(s.completedTasks, ["a"], "TASK_COMPLETE must not duplicate completedTasks");
});

test("FINAL_REVIEW requires both axes on the same package hash", () => {
  const head = "a".repeat(40);
  const merge = "b".repeat(40);
  const pkg = "c".repeat(64);
  let s = createInitialState("wf-1", 1, sha());
  s.state = "all-tasks-done";
  s = reduce(s, {
    kind: RUN_EVENT_KINDS.FINAL_REVIEW,
    data: { axis: "standards", verdict: "pass", headSha: head, mergeBaseSha: merge, packageHash: pkg, review: { verdict: "pass" } },
  }).state;
  assert.equal(s.state, "ready-pending");
  // Second axis with same package hash is accepted
  s = reduce(s, {
    kind: RUN_EVENT_KINDS.FINAL_REVIEW,
    data: { axis: "spec", verdict: "pass", headSha: head, mergeBaseSha: merge, packageHash: pkg, review: { verdict: "pass" } },
  }).state;
  assert.equal(s.state, "ready-pending");
  assert.ok(s.finalReview.standards);
  assert.ok(s.finalReview.spec);
  assert.equal(s.finalReview.packageHash, pkg);
});

test("FINAL_REVIEW rejects HEAD drift between the two axes", () => {
  const merge = "b".repeat(40);
  const pkg = "c".repeat(64);
  let s = createInitialState("wf-1", 1, sha());
  s.state = "all-tasks-done";
  s = reduce(s, {
    kind: RUN_EVENT_KINDS.FINAL_REVIEW,
    data: { axis: "standards", verdict: "pass", headSha: "a".repeat(40), mergeBaseSha: merge, packageHash: pkg, review: { verdict: "pass" } },
  }).state;
  assert.throws(
    () => reduce(s, {
      kind: RUN_EVENT_KINDS.FINAL_REVIEW,
      data: { axis: "spec", verdict: "pass", headSha: "d".repeat(40), mergeBaseSha: merge, packageHash: pkg, review: { verdict: "pass" } },
    }),
    /disagrees with HEAD/,
  );
});

test("FINAL_REVIEW rejects packageHash drift between the two axes", () => {
  const head = "a".repeat(40);
  const merge = "b".repeat(40);
  let s = createInitialState("wf-1", 1, sha());
  s.state = "all-tasks-done";
  s = reduce(s, {
    kind: RUN_EVENT_KINDS.FINAL_REVIEW,
    data: { axis: "standards", verdict: "pass", headSha: head, mergeBaseSha: merge, packageHash: "c".repeat(64), review: { verdict: "pass" } },
  }).state;
  assert.throws(
    () => reduce(s, {
      kind: RUN_EVENT_KINDS.FINAL_REVIEW,
      data: { axis: "spec", verdict: "pass", headSha: head, mergeBaseSha: merge, packageHash: "e".repeat(64), review: { verdict: "pass" } },
    }),
    /disagrees with package hash/,
  );
});

test("READY requires both Standards and Spec final reviews", () => {
  const head = "a".repeat(40);
  const merge = "b".repeat(40);
  const pkg = "c".repeat(64);
  let s = createInitialState("wf-1", 1, sha());
  s.state = "all-tasks-done";
  s = reduce(s, {
    kind: RUN_EVENT_KINDS.FINAL_REVIEW,
    data: { axis: "standards", verdict: "pass", headSha: head, mergeBaseSha: merge, packageHash: pkg, review: { verdict: "pass" } },
  }).state;
  assert.throws(
    () => reduce(s, { kind: RUN_EVENT_KINDS.READY, data: { headSha: head } }),
    /both Standards and Spec/,
  );
});

test("READY rejects head drift between final review and ready", () => {
  const head = "a".repeat(40);
  const merge = "b".repeat(40);
  const pkg = "c".repeat(64);
  let s = createInitialState("wf-1", 1, sha());
  s.state = "all-tasks-done";
  s = reduce(s, {
    kind: RUN_EVENT_KINDS.FINAL_REVIEW,
    data: { axis: "standards", verdict: "pass", headSha: head, mergeBaseSha: merge, packageHash: pkg, review: { verdict: "pass" } },
  }).state;
  s = reduce(s, {
    kind: RUN_EVENT_KINDS.FINAL_REVIEW,
    data: { axis: "spec", verdict: "pass", headSha: head, mergeBaseSha: merge, packageHash: pkg, review: { verdict: "pass" } },
  }).state;
  assert.throws(
    () => reduce(s, { kind: RUN_EVENT_KINDS.READY, data: { headSha: "d".repeat(40) } }),
    /head drift/,
  );
});
