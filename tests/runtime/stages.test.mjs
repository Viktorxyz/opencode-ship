import test from "node:test";
import assert from "node:assert/strict";
import { STAGES, progressLine } from "../../src/runtime/stages.js";

test("STAGES lists the twelve canonical ids", () => {
  assert.deepEqual(STAGES, [
    "setup", "discover", "shape", "plan", "approve",
    "track", "build", "review", "verify", "ready", "merge", "cleanup",
  ]);
});

test("progressLine: setup", () => {
  assert.equal(progressLine("setup"), "Setup: ready.");
});

test("progressLine: discover with installs", () => {
  assert.equal(progressLine("discover", { count: 3 }), "Discover: 3 skills installed.");
});

test("progressLine: discover none", () => {
  assert.equal(progressLine("discover"), "Discover: none (catalog only).");
});

test("progressLine: shape has no line", () => {
  assert.equal(progressLine("shape"), null);
});

test("progressLine: plan", () => {
  assert.equal(progressLine("plan", { path: "docs/plans/x.md" }), "Plan: docs/plans/x.md");
});

test("progressLine: approve has no line", () => {
  assert.equal(progressLine("approve"), null);
});

test("progressLine: track", () => {
  assert.equal(progressLine("track", { number: 12 }), "Track: issue #12.");
});

test("progressLine: build", () => {
  assert.equal(progressLine("build", { k: 2, n: 5, title: "stages" }), "Build: task 2/5 stages.");
});

test("progressLine: review pass", () => {
  assert.equal(progressLine("review", { ok: true }), "Review: pass.");
});

test("progressLine: review fail", () => {
  assert.equal(progressLine("review", { ok: false }), "Review: fail (see notes).");
});

test("progressLine: verify pass", () => {
  assert.equal(progressLine("verify", { ok: true }), "Verify: pass.");
});

test("progressLine: verify fail", () => {
  assert.equal(progressLine("verify", { ok: false }), "Verify: fail.");
});

test("progressLine: ready", () => {
  assert.equal(progressLine("ready", { number: 44 }), "Ready: PR #44.");
});

test("progressLine: merge", () => {
  assert.equal(progressLine("merge", { sha: "abc123" }), "Merge: abc123.");
});

test("progressLine: cleanup", () => {
  assert.equal(progressLine("cleanup"), "Cleanup: done.");
});
