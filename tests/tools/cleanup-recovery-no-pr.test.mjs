import { test, suite } from "node:test";
import assert from "node:assert/strict";
import { loadAdapter } from "../../src/adapter.js";
import { createCleanupTool, createIssueTool, createWorktreeTool } from "../../src/index.js";
import { writeManifest } from "../../src/state/manifest-store.js";
import { makeFixtureRepo, cleanupFixture, git, linkWorkflow } from "../helpers/fixture.mjs";

/**
 * Regression tests for delivery_cleanup bootstrap-failure recovery.
 *
 * After a bootstrap failure the manifest is in `cleanup-pending` with
 * no PR (`prNumber === null`). The v0.1.2 cleanup path refuses with
 * `missing-pr` and the manifest is stranded forever. The fix must
 * accept the `cleanup-pending` + `no-pr` shape when the worktree is
 * clean, the recorded bootstrap failed, and the base ref matches the
 * adapter's base branch; it then removes the worktree + branch +
 * manifest.
 */

function manifest(repoRoot, taskId, overrides) {
  return {
    schemaVersion: 1,
    taskId,
    repoIdentity: "a/b",
    issueNumber: 1,
    prNumber: null,
    baseBranch: "main",
    baseSha: "baseSha",
    branch: "backend/t1",
    worktreePath: `${repoRoot}/.worktrees/backend-t1`,
    lastPrHeadSha: null,
    lastReviewerSha: null,
    lastVerifierSha: null,
    owner: "test",
    state: "cleanup-pending",
    fatalReason: "bootstrap failed: pnpm install --frozen-lockfile failed (exit 1)",
    transitionLog: [
      { from: "issue-linked", to: "worktree-created", at: Date.now(), reason: "ok" },
      { from: "worktree-created", to: "cleanup-pending", at: Date.now(), reason: "bootstrap failed" },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function bootstrapWorktreeNoBootstrap(fixture) {
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
  return worktree({
    taskId: "t1",
    branch: "backend/t1",
    worktreeRelativePath: ".worktrees/backend-t1",
  });
}

suite("delivery_cleanup recovers from bootstrap failure (no PR)", { concurrency: false }, () => {
  test("removes worktree + branch + manifest when state=cleanup-pending and prNumber is null", { serial: true }, async () => {
    const fixture = makeFixtureRepo();
    try {
      const wt = await bootstrapWorktreeNoBootstrap(fixture);
      const wtPath = `${fixture.dir}/.worktrees/backend-t1`;
      await writeManifest(
        fixture.dir,
        manifest(fixture.dir, "t1", {
          worktreePath: wtPath,
          branch: "backend/t1",
          state: "cleanup-pending",
          prNumber: null,
          fatalReason: "bootstrap failed: stub",
        }),
      );

      const cleanup = createCleanupTool({
        repoRoot: fixture.dir,
        remote: "origin",
        driver: {
          readPullRequest: async () => {
            throw new Error("driver.readPullRequest must not be called when prNumber is null");
          },
        },
        repoSlug: "a/b",
        owner: "test",
      });
      const r = await cleanup({ taskId: "t1" });
      assert.equal(r.kind, undefined, `unexpected envelope: ${JSON.stringify(r)}`);
      assert.ok(r.removedPath?.endsWith("backend-t1"));
      const list = git(fixture.dir, ["worktree", "list", "--porcelain"]);
      assert.ok(
        !list.stdout.includes("backend-t1"),
        "worktree must be removed",
      );
      const showRef = git(fixture.dir, ["show-ref", "--verify", "--quiet", "refs/heads/backend/t1"]);
      assert.notEqual(showRef.status, 0, "local branch must be deleted");
    } finally {
      cleanupFixture(fixture);
    }
  });

  test("refuses when worktree is dirty even with no PR", { serial: true }, async () => {
    const fixture = makeFixtureRepo();
    try {
      const wt = await bootstrapWorktreeNoBootstrap(fixture);
      const wtPath = `${fixture.dir}/.worktrees/backend-t1`;
      const { writeFileSync } = await import("node:fs");
      writeFileSync(`${wtPath}/dirty.txt`, "x");
      await writeManifest(
        fixture.dir,
        manifest(fixture.dir, "t1", {
          worktreePath: wtPath,
          branch: "backend/t1",
          state: "cleanup-pending",
          prNumber: null,
        }),
      );

      const cleanup = createCleanupTool({
        repoRoot: fixture.dir,
        remote: "origin",
        driver: {},
        repoSlug: "a/b",
        owner: "test",
      });
      const r = await cleanup({ taskId: "t1" });
      assert.equal(r.kind, "dirty-worktree", `expected dirty-worktree, got ${JSON.stringify(r)}`);
    } finally {
      cleanupFixture(fixture);
    }
  });
});
