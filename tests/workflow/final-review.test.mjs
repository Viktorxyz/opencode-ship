/*
 * Final review coordinator tests.
 *
 * The Standards + Spec final reviewers are dispatched in
 * parallel against the same merge-base-to-HEAD package. The
 * `bindFinalReview` function is the gate the controller
 * reads before `delivery_ready`; the gate refuses when the
 * two axes disagree on the package identity, the HEAD, or
 * the verdict.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFinalReviewPackage,
  hashFinalReviewPackage,
  bindFinalReview,
} from "../../src/workflow/final-review.js";

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function baseInput(overrides = {}) {
  return {
    workflowId: "wf-1",
    headSha: "a".repeat(40),
    mergeBaseSha: "b".repeat(40),
    planHash: "c".repeat(64),
    approvalHash: "d".repeat(64),
    gateTaskId: "delivery-1",
    verificationHash: "e".repeat(64),
    ciHash: "f".repeat(64),
    tasks: [
      { taskId: "t1", commitSha: "1".repeat(40), taskHash: "2".repeat(64), reviewHash: "3".repeat(64) },
      { taskId: "t2", commitSha: "4".repeat(40), taskHash: "5".repeat(64), reviewHash: "6".repeat(64) },
    ],
    builtAt: "2026-08-05T00:00:00Z",
    ...overrides,
  };
}

test("final-review: package hash is 64-char hex", () => {
  const pkg = buildFinalReviewPackage(baseInput());
  assert.match(pkg.packageHash, HEX64);
  assert.equal(hashFinalReviewPackage(pkg), pkg.packageHash);
});

test("final-review: tasks are sorted by id for hash stability", () => {
  const a = buildFinalReviewPackage(baseInput());
  const b = buildFinalReviewPackage(baseInput({
    tasks: [
      { taskId: "t2", commitSha: "4".repeat(40), taskHash: "5".repeat(64), reviewHash: "6".repeat(64) },
      { taskId: "t1", commitSha: "1".repeat(40), taskHash: "2".repeat(64), reviewHash: "3".repeat(64) },
    ],
  }));
  assert.equal(a.packageHash, b.packageHash, "task order must not affect the hash");
});

test("final-review: package hash changes when any field changes", () => {
  const a = buildFinalReviewPackage(baseInput());
  const b = buildFinalReviewPackage(baseInput({ headSha: "z".repeat(40) }));
  assert.match(a.headSha, HEX40);
  assert.notEqual(a.packageHash, b.packageHash);
});

test("final-review: rejects missing required field", () => {
  assert.throws(() => buildFinalReviewPackage({ ...baseInput(), workflowId: "" }), /workflowId must be a non-empty string/);
  assert.throws(() => buildFinalReviewPackage({ ...baseInput(), tasks: "not-an-array" }), /tasks must be an array/);
  assert.throws(() => buildFinalReviewPackage({ ...baseInput(), tasks: [{}] }), /task.taskId must be a non-empty string/);
  assert.throws(() => buildFinalReviewPackage({ ...baseInput(), tasks: [null] }), /each task entry must be an object/);
});

test("bindFinalReview: ok when both axes pass on the same package and HEAD", () => {
  const pkg = buildFinalReviewPackage(baseInput());
  const r = bindFinalReview(
    { axis: "standards", verdict: "pass", reviewerSessionID: "s1", reviewerModel: "openai/gpt-5.6-sol", reviewedAt: "2026-08-05T00:00:00Z", headSha: pkg.headSha, mergeBaseSha: pkg.mergeBaseSha, packageHash: pkg.packageHash, findings: [] },
    { axis: "spec", verdict: "pass", reviewerSessionID: "s2", reviewerModel: "openai/gpt-5.6-sol", reviewedAt: "2026-08-05T00:00:00Z", headSha: pkg.headSha, mergeBaseSha: pkg.mergeBaseSha, packageHash: pkg.packageHash, findings: [] },
  );
  assert.equal(r.ok, true);
  assert.equal(r.headSha, pkg.headSha);
});

test("bindFinalReview: rejects a head mismatch", () => {
  const pkg = buildFinalReviewPackage(baseInput());
  const r = bindFinalReview(
    { axis: "standards", verdict: "pass", reviewerSessionID: "s1", reviewerModel: "openai/gpt-5.6-sol", reviewedAt: "2026-08-05T00:00:00Z", headSha: pkg.headSha, mergeBaseSha: pkg.mergeBaseSha, packageHash: pkg.packageHash, findings: [] },
    { axis: "spec", verdict: "pass", reviewerSessionID: "s2", reviewerModel: "openai/gpt-5.6-sol", reviewedAt: "2026-08-05T00:00:00Z", headSha: "different".padEnd(40, "0"), mergeBaseSha: pkg.mergeBaseSha, packageHash: pkg.packageHash, findings: [] },
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /head-mismatch/);
});

test("bindFinalReview: rejects a package mismatch", () => {
  const pkg = buildFinalReviewPackage(baseInput());
  const r = bindFinalReview(
    { axis: "standards", verdict: "pass", reviewerSessionID: "s1", reviewerModel: "openai/gpt-5.6-sol", reviewedAt: "2026-08-05T00:00:00Z", headSha: pkg.headSha, mergeBaseSha: pkg.mergeBaseSha, packageHash: "other".padEnd(64, "0"), findings: [] },
    { axis: "spec", verdict: "pass", reviewerSessionID: "s2", reviewerModel: "openai/gpt-5.6-sol", reviewedAt: "2026-08-05T00:00:00Z", headSha: pkg.headSha, mergeBaseSha: pkg.mergeBaseSha, packageHash: pkg.packageHash, findings: [] },
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /package-mismatch/);
});

test("bindFinalReview: rejects a non-pass verdict", () => {
  const pkg = buildFinalReviewPackage(baseInput());
  const r = bindFinalReview(
    { axis: "standards", verdict: "fail", reviewerSessionID: "s1", reviewerModel: "openai/gpt-5.6-sol", reviewedAt: "2026-08-05T00:00:00Z", headSha: pkg.headSha, mergeBaseSha: pkg.mergeBaseSha, packageHash: pkg.packageHash, findings: [{ axis: "standards", severity: "blocking", message: "missing integration test" }] },
    { axis: "spec", verdict: "pass", reviewerSessionID: "s2", reviewerModel: "openai/gpt-5.6-sol", reviewedAt: "2026-08-05T00:00:00Z", headSha: pkg.headSha, mergeBaseSha: pkg.mergeBaseSha, packageHash: pkg.packageHash, findings: [] },
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /verdict/);
});

test("bindFinalReview: rejects a blocking finding even with pass verdicts", () => {
  const pkg = buildFinalReviewPackage(baseInput());
  const r = bindFinalReview(
    { axis: "standards", verdict: "pass", reviewerSessionID: "s1", reviewerModel: "openai/gpt-5.6-sol", reviewedAt: "2026-08-05T00:00:00Z", headSha: pkg.headSha, mergeBaseSha: pkg.mergeBaseSha, packageHash: pkg.packageHash, findings: [{ axis: "standards", severity: "blocking", message: "x" }] },
    { axis: "spec", verdict: "pass", reviewerSessionID: "s2", reviewerModel: "openai/gpt-5.6-sol", reviewedAt: "2026-08-05T00:00:00Z", headSha: pkg.headSha, mergeBaseSha: pkg.mergeBaseSha, packageHash: pkg.packageHash, findings: [] },
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /blocking-findings/);
});
