/**
 * Final review coordinator.
 *
 * Builds an immutable, hash-bound final-review package from
 * the merge-base-to-HEAD commits and dispatches the Standards
 * and Spec reviewers in parallel against the same package.
 * Both records are bound to one HEAD; the controller refuses
 * to mark Ready if either axis is missing or fails.
 *
 * The package hash is the canonical identity of the final
 * review. Any later code change invalidates the package and
 * forces a re-review.
 */

import { createHash } from "node:crypto";
import { canonicalJson } from "../installer/json-pointer.js";

/**
 * @typedef {Object} FinalReviewAxisRecord
 * @property {"standards" | "spec"} axis
 * @property {"pass" | "fail"} verdict
 * @property {string} reviewerSessionID
 * @property {string} reviewerModel
 * @property {string} reviewedAt
 * @property {string} headSha
 * @property {string} mergeBaseSha
 * @property {string} packageHash
 * @property {Array<{ axis: "standards" | "spec", severity: "info" | "warning" | "blocking", message: string, pointer?: string, reproducer?: string }>} findings
 * @property {string} [verdictHash]
 * @property {string} [reviewHash]
 */

/**
 * @typedef {Object} FinalReviewPackage
 * @property {string} workflowId
 * @property {string} headSha
 * @property {string} mergeBaseSha
 * @property {string} planHash
 * @property {string} approvalHash
 * @property {string} gateTaskId
 * @property {string} verificationHash
 * @property {string} ciHash
 * @property {Array<{ taskId: string, commitSha: string, taskHash: string, reviewHash: string }>} tasks
 * @property {string} packageHash
 * @property {string} builtAt
 */

/**
 * Build the canonical final-review package. The package is
 * the single input both reviewers consume; both reviewers
 * record their verdict against the same `headSha`,
 * `mergeBaseSha`, and `packageHash`.
 *
 * @param {{
 *   workflowId: string,
 *   headSha: string,
 *   mergeBaseSha: string,
 *   planHash: string,
 *   approvalHash: string,
 *   gateTaskId: string,
 *   verificationHash: string,
 *   ciHash: string,
 *   tasks: Array<{ taskId: string, commitSha: string, taskHash: string, reviewHash: string }>,
 *   builtAt: string,
 * }} input
 * @returns {FinalReviewPackage}
 */
export function buildFinalReviewPackage(input) {
  for (const [k, v] of Object.entries(input)) {
    if (k === "tasks") continue;
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`buildFinalReviewPackage: ${k} must be a non-empty string`);
    }
  }
  if (!Array.isArray(input.tasks)) {
    throw new Error("buildFinalReviewPackage: tasks must be an array");
  }
  for (const t of input.tasks) {
    if (!t || typeof t !== "object") {
      throw new Error("buildFinalReviewPackage: each task entry must be an object");
    }
  }
  for (const t of input.tasks) {
    for (const k of ["taskId", "commitSha", "taskHash", "reviewHash"]) {
      if (typeof t[k] !== "string" || t[k].length === 0) {
        throw new Error(`buildFinalReviewPackage: task.${k} must be a non-empty string`);
      }
    }
  }
  const { tasks, ...header } = input;
  // Sort tasks by taskId so the package hash is stable.
  const sortedTasks = [...tasks].sort((a, b) => a.taskId < b.taskId ? -1 : a.taskId === b.taskId ? 0 : 1);
  const packageHash = sha256(canonicalJson({ ...header, tasks: sortedTasks }));
  return { ...header, tasks: sortedTasks, packageHash };
}

/**
 * @param {FinalReviewPackage} pkg
 * @returns {string}
 */
export function hashFinalReviewPackage(pkg) {
  const { packageHash: _packageHash, ...payload } = pkg;
  return sha256(canonicalJson(payload));
}

/**
 * @param {FinalReviewAxisRecord} record
 * @returns {string}
 */
export function hashAxisRecord(record) {
  const { reviewHash: _reviewHash, ...payload } = record;
  return sha256(canonicalJson(payload));
}

/**
 * Bind the two parallel axis records to one HEAD. The
 * function refuses to merge records that disagree on
 * `headSha`, `mergeBaseSha`, or `packageHash`. The result
 * is the gate the controller reads before `delivery_ready`.
 *
 * @param {FinalReviewAxisRecord} standards
 * @param {FinalReviewAxisRecord} spec
 * @returns {{ ok: boolean, reason?: string, headSha?: string }}
 */
export function bindFinalReview(standards, spec) {
  if (standards.headSha !== spec.headSha) {
    return { ok: false, reason: `head-mismatch: standards=${standards.headSha} spec=${spec.headSha}` };
  }
  if (standards.mergeBaseSha !== spec.mergeBaseSha) {
    return { ok: false, reason: `merge-base-mismatch: standards=${standards.mergeBaseSha} spec=${spec.mergeBaseSha}` };
  }
  if (standards.packageHash !== spec.packageHash) {
    return { ok: false, reason: `package-mismatch: standards=${standards.packageHash} spec=${spec.packageHash}` };
  }
  if (standards.verdict !== "pass" || spec.verdict !== "pass") {
    return { ok: false, reason: `verdict: standards=${standards.verdict} spec=${spec.verdict}` };
  }
  const blocking = [...(standards.findings ?? []), ...(spec.findings ?? [])].filter((f) => f.severity === "blocking");
  if (blocking.length > 0) {
    return { ok: false, reason: `blocking-findings: ${blocking.length}` };
  }
  return { ok: true, headSha: standards.headSha };
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
