/**
 * delivery_merge tool.
 *
 * Performs an explicit-user-request-only squash merge. Re-runs every
 * gate before issuing the merge so a stale Ready is rejected; the
 * caller cannot bypass verification just because the manifest already
 * says `ready`.
 */

import { readManifest, writeManifest } from "../state/manifest-store.js";
import { transition } from "../state/lifecycle.js";
import { checkGates, gateFailureEnvelope } from "../gates.js";
import { readFinalReviewEvidence } from "../workflow/final-review-store.js";
import { appendRunEvent, RUN_EVENT_KINDS } from "../workflow/run-controller.js";

export function createMergeTool(deps) {
  return async function merge(input) {
    const m = await readManifest(deps.repoRoot, input.taskId);
    if (!m) return { kind: "missing-manifest", taskId: input.taskId };
    if (m.prNumber === null) return { kind: "missing-pr" };
    if (m.state !== "ready") {
      return { kind: "not-ready", state: m.state };
    }

    const pr = await deps.driver.readPullRequest({
      repo: deps.repoSlug,
      number: m.prNumber,
    });
    if (pr.baseRefName !== m.baseBranch) {
      return { kind: "wrong-base", base: pr.baseRefName };
    }

    const freshGates = deps.adapter?.merge?.requireFreshGates !== false;
    let finalEvidence = null;
    if (m.workflowId) {
      try {
        finalEvidence = await readFinalReviewEvidence(deps.repoRoot, m.workflowId);
      } catch (err) {
        return { kind: "invalid-final-review-evidence", workflowId: m.workflowId, reason: String(err?.message ?? err) };
      }
    } else if (m.schemaVersion >= 2) {
      return { kind: "missing-workflow-link", taskId: m.taskId };
    }

    if (pr.headSha !== (m.lastPrHeadSha ?? pr.headSha)) {
      return {
        kind: "head-changed",
        headSha: pr.headSha,
        manifestSha: m.lastPrHeadSha ?? "",
      };
    }

    async function recordMerged(merged, reason) {
      const t = transition(
        { ...m, lastPrHeadSha: merged.headSha },
        "merged",
        { reason },
      );
      if (!t.ok) return { kind: "lifecycle", reason: t.reason };
      const next = {
        ...m,
        lastPrHeadSha: merged.headSha,
        state: t.to,
        transitionLog: [
          ...m.transitionLog,
          { from: t.from, to: t.to, at: t.at, reason: t.reason },
        ],
        updatedAt: new Date().toISOString(),
      };
      const path = await writeManifest(deps.repoRoot, next);
      if (finalEvidence && m.workflowId) {
        await appendRunEvent(deps.repoRoot, m.workflowId, finalEvidence.runState, {
          kind: RUN_EVENT_KINDS.MERGE,
          data: { mergeSha: merged.mergeSha ?? merged.mergeCommitSha ?? merged.headSha },
        });
      }
      return { kind: "merge", contractVersion: 1, manifestPath: path, pr: m.prNumber, taskId: m.taskId };
    }

    // A maintainer may merge through GitHub after every gate passed. Reconcile
    // that terminal remote fact instead of trying to merge the PR a second time.
    if (pr.merged) {
      return recordMerged(pr, `reconciled external merge as ${input.subject}`);
    }

    if (freshGates) {
      const required = deps.adapter?.ready?.requires ?? [
        "review",
        "local-verification",
        "remote-ci",
      ];
      const ciDriverAvailable = Boolean(deps.adapter?.ci?.driver);
      const checks = ciDriverAvailable
        ? await deps.driver.readChecks({
            repo: deps.repoSlug,
            number: m.prNumber,
            branch: m.branch,
            required: deps.adapter?.ci?.requiredChecks ?? [],
          })
        : [];
      const result = checkGates({
        manifest: {
          ...m,
          finalStandardsReview: finalEvidence?.standards ?? m.finalStandardsReview,
          finalSpecReview: finalEvidence?.spec ?? m.finalSpecReview,
          adapter: deps.adapter,
        },
        prHead: pr.headSha,
        checks,
        requires: required,
      });
      if (!result.ok) return gateFailureEnvelope(result);
    }

    if (pr.draft) return { kind: "not-mergeable", reason: "PR is still draft" };
    if (pr.mergeable !== "MERGEABLE") {
      return { kind: "not-mergeable", reason: `mergeable=${pr.mergeable}` };
    }

    const merged = await deps.driver.mergePullRequest({
      repo: deps.repoSlug,
      number: m.prNumber,
      subject: input.subject,
    });
    return recordMerged(merged, `squash merged as ${input.subject}`);
  };
}
