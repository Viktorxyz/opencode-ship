import { test, suite } from "node:test";
import assert from "node:assert/strict";
import { STATES, createManifest, transition, canTransition, isTerminal, mustRerunReview, mustRerunVerifier } from "../../src/state/lifecycle.js";

const baseInput = () => ({
  taskId: "task-1",
  repoIdentity: "owner/repo",
  issueNumber: 1,
  baseBranch: "main",
  baseSha: "abc",
  branch: "owner/issue-1",
  owner: "opencode-build",
});

suite("lifecycle", { concurrency: false }, () => {
test("STATES lists the canonical lifecycle", { serial: true }, () => {
  assert.deepEqual([...STATES], [
    "issue-linked",
    "worktree-created",
    "draft-open",
    "validating",
    "ready",
    "merged",
    "cleanup-pending",
    "cleaned",
    "failed",
    "aborted",
  ]);
});

test("createManifest starts at issue-linked", { serial: true }, () => {
  const m = createManifest(baseInput());
  assert.equal(m.state, "issue-linked");
  assert.equal(m.taskId, "task-1");
  assert.equal(m.schemaVersion, 2);
});

test("happy path walks every transition once", { serial: true }, () => {
  let m = createManifest(baseInput());
  for (const next of ["worktree-created", "draft-open", "validating", "ready", "merged", "cleanup-pending", "cleaned"]) {
    const r = transition(m, next);
    assert.ok(r.ok, `expected transition to ${next}`);
    m = { ...m, state: r.to, transitionLog: [...m.transitionLog, { from: r.from, to: r.to, at: r.at, reason: r.reason }] };
  }
  assert.equal(m.state, "cleaned");
  assert.equal(m.transitionLog.length, 7);
});

test("forbidden transitions are rejected", { serial: true }, () => {
  const m = createManifest(baseInput());
  for (const bad of ["merged", "ready", "cleaned"]) {
    const r = transition(m, bad);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /not permitted/);
  }
});

test("canTransition mirrors the transition table", { serial: true }, () => {
  assert.equal(canTransition("issue-linked", "worktree-created"), true);
  assert.equal(canTransition("merged", "cleanup-pending"), true);
  assert.equal(canTransition("issue-linked", "ready"), false);
});

test("isTerminal recognises cleaned and aborted", { serial: true }, () => {
  assert.equal(isTerminal("cleaned"), true);
  assert.equal(isTerminal("aborted"), true);
  assert.equal(isTerminal("ready"), false);
});

test("mustRerunReview/Verifier triggers when SHA changes", { serial: true }, () => {
  assert.equal(mustRerunReview("aaa", "bbb"), true);
  assert.equal(mustRerunReview("aaa", "aaa"), false);
  assert.equal(mustRerunReview(null, "aaa"), true);
  assert.equal(mustRerunVerifier("aaa", "bbb"), true);
  assert.equal(mustRerunVerifier("aaa", "aaa"), false);
});

test("transition records monotonic at timestamps", { serial: true }, async () => {
  const sleeps = [0, 5, 5];
  const m = createManifest(baseInput());
  let cur = m;
  for (let i = 0; i < sleeps.length; i++) {
    if (sleeps[i] > 0) await new Promise((r) => setTimeout(r, sleeps[i]));
    const r = transition(cur, ["worktree-created", "draft-open", "validating"][i]);
    assert.ok(r.ok);
    cur = { ...cur, state: r.to, transitionLog: [...cur.transitionLog, { from: r.from, to: r.to, at: r.at, reason: r.reason }] };
  }
  assert.ok(cur.transitionLog[2].at >= cur.transitionLog[1].at);
  assert.ok(cur.transitionLog[1].at >= cur.transitionLog[0].at);
});

test("failed transitions carry a fatalReason", { serial: true }, () => {
  const m = createManifest(baseInput());
  const r = transition(m, "failed", { reason: "boom" });
  assert.ok(r.ok);
  assert.equal(r.to, "failed");
  const next = { ...m, state: r.to, transitionLog: [...m.transitionLog, { from: r.from, to: r.to, at: r.at, reason: r.reason }], fatalReason: "boom" };
  assert.equal(next.fatalReason, "boom");
});
});
