/**
 * Centralised Ready/Merge gate checking.
 *
 * The lifecycle guarantees that we never mark a PR Ready, and never
 * merge it, without observing the same HEAD SHA across every gate.
 * From 1.1.1 the engineering workflow requires:
 *
 *   1. Standards final review (final-standards-reviewer) at this SHA.
 *   2. Spec final review (final-spec-reviewer) at this SHA.
 *   3. Verifier exit 0 at this SHA.
 *   4. Every required CI check (from the adapter) in the `pass`
 *      bucket on this SHA.
 *
 * The legacy single-review gate is still available for consumers on
 * pre-1.1.1 manifests that have not migrated to dual-axis final
 * review.
 *
 * Missing or pending checks return typed envelopes that the calling
 * tool can surface verbatim.
 */

const CHECK_BUCKETS = new Map([
  ["pass", "pass"],
  ["fail", "fail"],
  ["pending", "pending"],
  ["skip", "skip"],
  ["neutral", "neutral"],
]);

export function bucketFor(check) {
  if (!check) return "pending";
  if (CHECK_BUCKETS.has(check.bucket)) return check.bucket;
  if (check.state === "success") return "pass";
  if (check.state === "failure") return "fail";
  return "pending";
}

export function finalReviewGateSnapshot(manifest) {
  return {
    standards: manifest?.finalStandardsReview ?? null,
    spec: manifest?.finalSpecReview ?? null,
  };
}

/**
 * Take a manifest + the current PR head SHA + driver readChecks
 * result, and return the structured gate snapshot the calling tool
 * needs to make a Ready/Merge decision.
 */
export function gateSnapshot({ manifest, prHead, checks }) {
  const required = manifest.adapter?.ci?.requiredChecks ?? [];
  const observed = checks ?? [];
  const missing = [];
  const failing = [];
  const pending = [];
  for (const name of required) {
    const match = observed.find((c) => c.name === name);
    if (!match) {
      missing.push(name);
      pending.push(name);
      continue;
    }
    const bucket = bucketFor(match);
    if (bucket === "fail") failing.push(name);
    else if (bucket === "pending") pending.push(name);
  }
  return {
    prHead: prHead ?? null,
    reviewerSha: manifest?.lastReviewerSha ?? null,
    verifierSha: manifest?.lastVerifierSha ?? null,
    finalReviews: finalReviewGateSnapshot(manifest ?? {}),
    checks: observed,
    missingChecks: missing,
    failingChecks: failing,
    pendingChecks: pending,
  };
}

/**
 * The shared Ready/Merge gate predicate. Engineering manifests
 * require both Standards and Spec final reviews bound to the same
 * HEAD. Legacy manifests with only `lastReviewerSha` fall through
 * to the legacy single-review gate.
 */
export function checkGates({ manifest, prHead, checks, requires }) {
  const snap = gateSnapshot({ manifest, prHead, checks });
  const need = new Set(requires ?? ["review", "local-verification", "remote-ci"]);
  const hasDualFinalReview = Boolean(
    manifest?.finalStandardsReview || manifest?.finalSpecReview
  );

  if (need.has("review")) {
    if (hasDualFinalReview) {
      const standards = manifest?.finalStandardsReview;
      const spec = manifest?.finalSpecReview;
      if (!standards || !standards.headSha) {
        return { ok: false, reason: "missing-final-review", axis: "standards", snapshot: snap };
      }
      if (!spec || !spec.headSha) {
        return { ok: false, reason: "missing-final-review", axis: "spec", snapshot: snap };
      }
      if (standards.headSha !== prHead) {
        return { ok: false, reason: "head-changed-after-final-review", axis: "standards", snapshot: snap };
      }
      if (spec.headSha !== prHead) {
        return { ok: false, reason: "head-changed-after-final-review", axis: "spec", snapshot: snap };
      }
      if (standards.headSha !== spec.headSha) {
        return { ok: false, reason: "final-review-head-mismatch", snapshot: snap };
      }
      if ((standards.packageHash ?? null) !== (spec.packageHash ?? null)) {
        return { ok: false, reason: "final-review-package-mismatch", snapshot: snap };
      }
      if ((standards.verdict ?? null) !== "pass" || (spec.verdict ?? null) !== "pass") {
        return { ok: false, reason: "final-review-failed", snapshot: snap };
      }
    } else {
      if (!manifest?.lastReviewerSha) return { ok: false, reason: "missing-review", snapshot: snap };
      if (manifest.lastReviewerSha !== prHead) {
        return { ok: false, reason: "head-changed-after-review", snapshot: snap };
      }
    }
  }

  if (need.has("local-verification")) {
    if (!manifest?.lastVerifierSha) return { ok: false, reason: "missing-verifier", snapshot: snap };
    if (manifest.lastVerifierSha !== prHead) {
      return { ok: false, reason: "head-changed-after-verifier", snapshot: snap };
    }
  }

  if (need.has("remote-ci")) {
    if (snap.missingChecks.length > 0) {
      return { ok: false, reason: "ci-missing", snapshot: snap };
    }
    if (snap.failingChecks.length > 0) {
      return { ok: false, reason: "ci-failing", snapshot: snap };
    }
    if (snap.pendingChecks.length > 0) {
      return { ok: false, reason: "ci-pending", snapshot: snap };
    }
  }

  return { ok: true, snapshot: snap };
}

/**
 * Convert a gate-failure reason into the typed envelope shape used by
 * the Ready/Merge tools. Keeps the error vocabulary in one place.
 */
export function gateFailureEnvelope(result) {
  switch (result.reason) {
    case "missing-review":
      return { kind: "missing-gate", gate: "review" };
    case "missing-verifier":
      return { kind: "missing-gate", gate: "local-verification" };
    case "missing-final-review":
      return {
        kind: "missing-final-review",
        axis: result.axis,
      };
    case "final-review-head-mismatch":
      return { kind: "final-review-head-mismatch" };
    case "final-review-package-mismatch":
      return { kind: "final-review-package-mismatch" };
    case "final-review-failed":
      return { kind: "final-review-failed" };
    case "head-changed-after-review":
      return {
        kind: "head-changed-after-review",
        headSha: result.snapshot.prHead ?? "",
        reviewSha: result.snapshot.reviewerSha ?? "",
      };
    case "head-changed-after-verifier":
      return {
        kind: "head-changed-after-verifier",
        headSha: result.snapshot.prHead ?? "",
        verifierSha: result.snapshot.verifierSha ?? "",
      };
    case "head-changed-after-final-review":
      return {
        kind: "head-changed-after-final-review",
        axis: result.axis,
        headSha: result.snapshot.prHead ?? "",
      };
    case "ci-missing":
      return { kind: "ci-missing", missing: result.snapshot.missingChecks };
    case "ci-failing":
      return { kind: "ci-failing", failing: result.snapshot.failingChecks };
    case "ci-pending":
      return { kind: "ci-pending", pending: result.snapshot.pendingChecks };
    default:
      return { kind: "gate-failed", reason: result.reason };
  }
}
