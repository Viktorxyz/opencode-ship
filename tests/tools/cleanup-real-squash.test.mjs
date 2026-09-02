import { test, suite } from "node:test";
import assert from "node:assert/strict";
import { loadAdapter } from "../../src/adapter.js";
import { createCleanupTool, createIssueTool, createWorktreeTool } from "../../src/index.js";
import { writeManifest } from "../../src/state/manifest-store.js";
import { makeFixtureRepo, cleanupFixture, git, linkWorkflow } from "../helpers/fixture.mjs";

/**
 * Regression tests for delivery_cleanup after a real squash merge.
 *
 * The v0.1.2 implementation deletes the local feature branch with
 * `git branch -d`. After a real squash merge, the feature commit is
 * not an ancestor of the merged `main`, so `git branch -d` fails with
 * `not fully merged`. The fix must remove the branch safely (using a
 * CAS-style expected-SHA guard or equivalent) when the head matches
 * the recorded lastPrHeadSha.
 */

function manifest(repoRoot, taskId, overrides) {
  return {
    schemaVersion: 1,
    taskId,
    repoIdentity: "a/b",
    issueNumber: 1,
    prNumber: 7,
    baseBranch: "main",
    baseSha: "baseSha",
    branch: "backend/t1",
    worktreePath: `${repoRoot}/.worktrees/backend-t1`,
    lastPrHeadSha: "featSha",
    lastReviewerSha: "featSha",
    lastVerifierSha: "featSha",
    owner: "test",
    state: "merged",
    transitionLog: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function bootstrapWorktreeWithFeatureCommit(fixture) {
  const adapter = await loadAdapter(fixture.dir);
  const issue = createIssueTool({
    repoRoot: fixture.dir,
    driver: {
      ensureIssue: async () => ({
        summary: { number: 1, url: "u", state: "OPEN", pullRequest: null },
        created: true,
      }),
    },
    repoSlug: "a/b",
    owner: "test",
    adapter: adapter.adapter,
  });
  await issue({
    taskId: "t1",
    title: "T",
    body: "B",
    baseBranch: "main",
    baseSha: "baseSha",
    branch: "backend/t1",
    labels: [],
  });
  await linkWorkflow(fixture.dir, "t1");
  const worktree = createWorktreeTool({
    repoRoot: fixture.dir,
    remote: "origin",
    adapter: adapter.adapter,
  });
  const wt = await worktree({
    taskId: "t1",
    branch: "backend/t1",
    worktreeRelativePath: ".worktrees/backend-t1",
  });
  // create a feature commit on the worktree that is NOT an ancestor of base
  const wtPath = `${fixture.dir}/.worktrees/backend-t1`;
  const { writeFileSync } = await import("node:fs");
  writeFileSync(`${wtPath}/feature.txt`, "feature\n");
  git(wtPath, ["add", "feature.txt"]);
  git(wtPath, ["commit", "-qm", "feature"]);
  const featHead = git(wtPath, ["rev-parse", "HEAD"]).stdout.trim();
  return { ...wt, featHead, wtPath };
}

suite("delivery_cleanup handles real-squash-merge deletion", { concurrency: false }, () => {
  test("deletes the local feature branch after squash merge using CAS guard", { serial: true }, async () => {
    const fixture = makeFixtureRepo();
    try {
      const { featHead, wtPath } = await bootstrapWorktreeWithFeatureCommit(fixture);
      await writeManifest(
        fixture.dir,
        manifest(fixture.dir, "t1", {
          state: "merged",
          worktreePath: wtPath,
          branch: "backend/t1",
          lastPrHeadSha: featHead,
          lastReviewerSha: featHead,
          lastVerifierSha: featHead,
        }),
      );

      const cleanup = createCleanupTool({
        repoRoot: fixture.dir,
        remote: "origin",
        driver: {
          readPullRequest: async () => ({
            number: 7,
            url: "u",
            baseRefName: "main",
            headRefName: "backend/t1",
            headSha: featHead,
            draft: false,
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            merged: true,
            mergedAt: "now",
          }),
        },
        repoSlug: "a/b",
        owner: "test",
      });
      const r = await cleanup({ taskId: "t1" });
      assert.equal(r.kind, undefined, `unexpected envelope: ${JSON.stringify(r)}`);
      const showRef = git(fixture.dir, ["show-ref", "--verify", "--quiet", "refs/heads/backend/t1"]);
      assert.notEqual(showRef.status, 0, "feature branch must be deleted after CAS guard");
    } finally {
      cleanupFixture(fixture);
    }
  });
});
