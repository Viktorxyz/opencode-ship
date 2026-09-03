/**
 * delivery_issue tool.
 *
 * Ensures an issue exists for the task. Always idempotent: if a
 * manifest already exists for the taskId, the existing state is
 * preserved (no SHA history is dropped). The issue on GitHub is
 * matched by title and reused; if missing, a new issue is created.
 * The PR is always linked to the issue via `Closes #N` on the PR
 * body (enforced by the gh driver).
 */

import { createManifest, transition } from "../state/lifecycle.js";
import { readManifest, writeManifest } from "../state/manifest-store.js";
import { nextLine, progressLine } from "../runtime/stages.js";

export function createIssueTool(deps) {
  return async function issue(input) {
    if (!input.taskId) return { kind: "missing-input", field: "taskId" };
    if (!input.title) return { kind: "missing-input", field: "title" };
    if (!input.baseBranch) return { kind: "missing-input", field: "baseBranch" };
    if (!input.branch) return { kind: "missing-input", field: "branch" };

    const existing = await readManifest(deps.repoRoot, input.taskId);
    if (existing) {
      const stage = "track";
      return {
        contractVersion: 1,
        created: false,
        issueNumber: existing.issueNumber,
        issueUrl: `https://github.com/${deps.repoSlug}/issues/${existing.issueNumber}`,
        manifestPath: "preserved",
        preserved: true,
        progress: progressLine(stage, { number: existing.issueNumber }),
        next: nextLine(stage),
      };
    }

    const ensured = await deps.driver.ensureIssue({
      repo: deps.repoSlug,
      title: input.title,
      body: input.body ?? "",
      labels: input.labels ?? [],
    });
    const m = createManifest({
      taskId: input.taskId,
      repoIdentity: deps.repoSlug,
      issueNumber: ensured.summary.number,
      baseBranch: input.baseBranch,
      baseSha: input.baseSha ?? "0000000000000000000000000000000000000000",
      branch: input.branch,
      owner: deps.owner,
      prNumber: null,
      lastPrHeadSha: null,
      lastReviewerSha: null,
      lastVerifierSha: null,
    });
    // Idempotent self-transition so re-running delivery_issue from a
    // manifest that already lives in issue-linked is a no-op.
    const t = transition(m, "issue-linked", {
      reason: ensured.created ? "issue just created" : "issue reused",
    });
    if (!t.ok) {
      return { kind: "lifecycle", reason: t.reason };
    }
    const next = {
      ...m,
      state: t.to,
      transitionLog: [
        ...m.transitionLog,
        { from: t.from, to: t.to, at: t.at, reason: t.reason },
      ],
      updatedAt: new Date().toISOString(),
    };
    const path = await writeManifest(deps.repoRoot, next);
    const stage = "track";
    return {
      contractVersion: 1,
      created: ensured.created,
      issueNumber: ensured.summary.number,
      issueUrl: ensured.summary.url,
      manifestPath: path,
      progress: progressLine(stage, { number: ensured.summary.number }),
      next: nextLine(stage),
    };
  };
}
