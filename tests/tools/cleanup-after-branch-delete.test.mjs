import { test, suite } from "node:test";
import assert from "node:assert/strict";
import { loadAdapter } from "../../src/adapter.js";
import { createIssueTool, createWorktreeTool, createCleanupTool } from "../../src/index.js";
import { makeFixtureRepo, cleanupFixture, linkWorkflow } from "../helpers/fixture.mjs";
import { writeManifest } from "../../src/state/manifest-store.js";
import { spawnSync } from "node:child_process";

/**
 * Regression tests for delivery_cleanup after remote-branch delete.
 *
 * GitHub deletes the remote feature branch immediately after a
 * squash merge. The v0.1.1 implementation refuses cleanup forever
 * because `git rev-list --count origin/<branch>..<branch>` exits
 * non-zero and `aheadCount` returns null. The fix must use a
 * CAS-style expected-SHA guard: when the remote ref is gone AND
 * the local branch head matches `lastPrHeadSha`, cleanup is safe.
 */

function manifest(repoRoot, taskId, overrides) {
  return {
    schemaVersion: 1,
    taskId,
    repoIdentity: "a/b",
    issueNumber: 1,
    prNumber: 7,
    baseBranch: "main",
    baseSha: "abc",
    branch: "backend/t1",
    worktreePath: `${repoRoot}/.worktrees/backend-t1`,
    lastPrHeadSha: "abc",
    lastReviewerSha: null,
    lastVerifierSha: "abc",
    owner: "test",
    state: "merged",
    transitionLog: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function bootstrapMergedWorktree(fixture) {
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
    baseSha: "abc",
    branch: "backend/t1",
    labels: [],
  });
  await linkWorkflow(fixture.dir, "t1");
  const worktree = createWorktreeTool({
    repoRoot: fixture.dir,
    remote: "origin",
    adapter: adapter.adapter,
  });
  return worktree({
    taskId: "t1",
    branch: "backend/t1",
    worktreeRelativePath: ".worktrees/backend-t1",
  });
}

suite("delivery_cleanup tolerates deleted remote branch", { concurrency: false }, () => {
  test("succeeds when remote feature branch is gone and head matches expected", { serial: true }, async () => {
    const fixture = makeFixtureRepo();
    try {
      const wt = await bootstrapMergedWorktree(fixture);
      const wtPath = `${fixture.dir}/.worktrees/backend-t1`;
      await writeManifest(
        fixture.dir,
        manifest(fixture.dir, "t1", {
          state: "merged",
          worktreePath: wtPath,
          lastPrHeadSha: wt.headSha,
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
            headSha: wt.headSha,
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
      assert.ok(r.removedPath?.endsWith("backend-t1"));
      const stillThere = spawnSync("git", ["worktree", "list", "--porcelain"], {
        cwd: fixture.dir,
        encoding: "utf8",
      });
      assert.ok(
        !stillThere.stdout.includes("backend-t1"),
        "worktree must be removed",
      );
    } finally {
      cleanupFixture(fixture);
    }
  });

  test("refuses when local head drifted from lastPrHeadSha", { serial: true }, async () => {
    const fixture = makeFixtureRepo();
    try {
      const wt = await bootstrapMergedWorktree(fixture);
      const wtPath = `${fixture.dir}/.worktrees/backend-t1`;
      const { writeFileSync } = await import("node:fs");
      const { execSync } = await import("node:child_process");
      writeFileSync(`${wtPath}/drift.txt`, "x");
      execSync("git add drift.txt && git commit -qm drift", { cwd: wtPath });
      await writeManifest(
        fixture.dir,
        manifest(fixture.dir, "t1", {
          state: "merged",
          worktreePath: wtPath,
          lastPrHeadSha: wt.headSha,
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
            headSha: wt.headSha,
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
      assert.equal(r.kind, "head-mismatch");
    } finally {
      cleanupFixture(fixture);
    }
  });
});
