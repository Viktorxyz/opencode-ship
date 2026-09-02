/**
 * delivery_ready tool.
 *
 * Marks the PR Ready for review only when every required gate has
 * observed the same HEAD SHA. Re-checks CI, review, and verifier
 * SHAs against the PR's current head. Never marks Ready if any gate
 * is missing, stale, pending, or failing.
 */

import { readManifest, writeManifest } from "../state/manifest-store.js";
import { transition } from "../state/lifecycle.js";
import { checkGates, gateFailureEnvelope } from "../gates.js";
import { appendRunEvent, RUN_EVENT_KINDS } from "../workflow/run-controller.js";
import { readFinalReviewEvidence } from "../workflow/final-review-store.js";
import { nextLine, progressLine } from "../runtime/stages.js";

export function createReadyTool(deps) {
  return async function ready(input) {
    const m = await readManifest(deps.repoRoot, input.taskId);
    if (!m) return { kind: "missing-manifest", taskId: input.taskId };
    if (m.prNumber === null) return { kind: "missing-pr" };
    const prHead = await deps.driver.refreshHead({
      repo: deps.repoSlug,
      number: m.prNumber,
    });

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

    let runState = null;
    let gateManifest = m;
    const suppliedWorkflowId = input.workflowId ? String(input.workflowId) : null;
    if (m.workflowId && suppliedWorkflowId && m.workflowId !== suppliedWorkflowId) {
      return { kind: "workflow-mismatch", expected: m.workflowId, received: suppliedWorkflowId };
    }
    const workflowId = m.workflowId ?? suppliedWorkflowId;
    if (m.schemaVersion >= 2 && !workflowId) {
      return { kind: "missing-workflow-link", taskId: m.taskId };
    }
    let finalEvidence = null;
    if (workflowId) {
      try {
        finalEvidence = await readFinalReviewEvidence(deps.repoRoot, workflowId);
      } catch (err) {
        return { kind: "invalid-final-review-evidence", workflowId, reason: String(err?.message ?? err) };
      }
      runState = finalEvidence.runState;
      gateManifest = {
        ...m,
        finalStandardsReview: finalEvidence.standards,
        finalSpecReview: finalEvidence.spec,
      };
    }

    const result = checkGates({
      manifest: { ...gateManifest, adapter: deps.adapter },
      prHead,
      checks,
      requires: required,
    });
    if (!result.ok) {
      return gateFailureEnvelope(result);
    }

    await deps.driver.markReady({
      repo: deps.repoSlug,
      number: m.prNumber,
    });
    const t = transition(m, "ready", { reason: "all gates fresh" });
    if (!t.ok) return { kind: "lifecycle", reason: t.reason };
    const next = {
      ...m,
      workflowId: workflowId ?? null,
      finalReviewPackageHash: finalEvidence?.package.packageHash ?? m.finalReviewPackageHash ?? null,
      finalStandardsReview: finalEvidence?.standards ?? m.finalStandardsReview ?? null,
      finalSpecReview: finalEvidence?.spec ?? m.finalSpecReview ?? null,
      lastPrHeadSha: prHead,
      state: t.to,
      transitionLog: [
        ...m.transitionLog,
        { from: t.from, to: t.to, at: t.at, reason: t.reason },
      ],
      updatedAt: new Date().toISOString(),
    };
    const path = await writeManifest(deps.repoRoot, next);
    if (runState && workflowId) {
      await appendRunEvent(deps.repoRoot, workflowId, runState, {
        kind: RUN_EVENT_KINDS.READY,
        data: { headSha: prHead, taskId: input.taskId },
      });
    }
    const stage = "ready";
    return {
      contractVersion: 1,
      manifestPath: path,
      pr: m.prNumber,
      workflowId,
      progress: progressLine(stage, { number: m.prNumber }),
      next: nextLine(stage),
    };
  };
}
