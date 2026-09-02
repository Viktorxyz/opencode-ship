import { test, suite } from "node:test";
import assert from "node:assert/strict";
import { loadAdapter } from "../../src/adapter.js";
import { createReviewTool, createCleanupTool, createIssueTool, createWorktreeTool } from "../../src/index.js";
import { makeFixtureRepo, cleanupFixture, git, linkWorkflow } from "../helpers/fixture.mjs";
import { writeManifest } from "../../src/state/manifest-store.js";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";

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
    state: "draft-open",
    transitionLog: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function bootstrapWorktree(fixture, adapter, taskId, branch) {
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
  });
  await issue({
    taskId,
    title: "T",
    body: "B",
    baseBranch: "main",
    baseSha: "abc",
    branch,
    labels: [],
  });
  await linkWorkflow(fixture.dir, "t1");
  const worktree = createWorktreeTool({
    repoRoot: fixture.dir,
    remote: "origin",
    adapter: adapter.adapter,
  });
  return worktree({
    taskId,
    branch,
    worktreeRelativePath: `.worktrees/${branch.replace("/", "-")}`,
  });
}

suite("delivery_review", { concurrency: false }, () => {
  test("records reviewer SHA on pass", { serial: true }, async () => {
    const fixture = makeFixtureRepo();
    try {
      await writeManifest(fixture.dir, manifest(fixture.dir, "t1"));
      const tool = createReviewTool({
        repoRoot: fixture.dir,
        driver: { refreshHead: async () => "abc" },
        repoSlug: "a/b",
        owner: "test",
      });
      const r = await tool({ taskId: "t1", status: "pass", headSha: "abc" });
      assert.equal(r.contractVersion, 1);
      assert.equal(r.reviewerSha, "abc");
    } finally {
      cleanupFixture(fixture);
    }
  });

  test("does not record reviewer SHA on fail", { serial: true }, async () => {
    const fixture = makeFixtureRepo();
    try {
      await writeManifest(fixture.dir, manifest(fixture.dir, "t1"));
      const tool = createReviewTool({
        repoRoot: fixture.dir,
        driver: { refreshHead: async () => "abc" },
        repoSlug: "a/b",
        owner: "test",
      });
      const r = await tool({ taskId: "t1", status: "fail" });
      assert.equal(r.kind, "review-not-pass");
      assert.equal(r.status, "fail");
    } finally {
      cleanupFixture(fixture);
    }
  });

  test("rejects head mismatch between review and PR", { serial: true }, async () => {
    const fixture = makeFixtureRepo();
    try {
      await writeManifest(fixture.dir, manifest(fixture.dir, "t1"));
      const tool = createReviewTool({
        repoRoot: fixture.dir,
        driver: { refreshHead: async () => "new" },
        repoSlug: "a/b",
        owner: "test",
      });
      const r = await tool({ taskId: "t1", status: "pass", headSha: "old" });
      assert.equal(r.kind, "head-mismatch");
    } finally {
      cleanupFixture(fixture);
    }
  });
});

suite("delivery_cleanup", { concurrency: false }, () => {
  test("refuses when manifest is not in a cleanup-eligible state", { serial: true }, async () => {
    const fixture = makeFixtureRepo();
    try {
      await writeManifest(fixture.dir, manifest(fixture.dir, "t1", { state: "draft-open" }));
      const tool = createCleanupTool({
        repoRoot: fixture.dir,
        remote: "origin",
        driver: { readPullRequest: async () => ({ number: 7, url: "u", baseRefName: "main", headRefName: "backend/t1", headSha: "abc", draft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", merged: true, mergedAt: "now" }) },
        repoSlug: "a/b",
        owner: "test",
      });
      const r = await tool({ taskId: "t1" });
      assert.equal(r.kind, "manifest-state");
    } finally {
      cleanupFixture(fixture);
    }
  });

  test("refuses with unmerged when PR is not merged", { serial: true }, async () => {
    const fixture = makeFixtureRepo();
    try {
      const adapter = await loadAdapter(fixture.dir);
      const wt = await bootstrapWorktree(fixture, adapter, "t1", "backend/t1");
      const wtPath = `${fixture.dir}/.worktrees/backend-t1`;
      await writeManifest(
        fixture.dir,
        manifest(fixture.dir, "t1", { state: "merged", worktreePath: wtPath, lastPrHeadSha: wt.headSha }),
      );
      const tool = createCleanupTool({
        repoRoot: fixture.dir,
        remote: "origin",
        driver: { readPullRequest: async () => ({ number: 7, url: "u", baseRefName: "main", headRefName: "backend/t1", headSha: wt.headSha, draft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", merged: false, mergedAt: null }) },
        repoSlug: "a/b",
        owner: "test",
      });
      const r = await tool({ taskId: "t1" });
      assert.equal(r.kind, "unmerged");
    } finally {
      cleanupFixture(fixture);
    }
  });

  test("refuses with base-mismatch when PR base differs from manifest", { serial: true }, async () => {
    const fixture = makeFixtureRepo();
    try {
      const adapter = await loadAdapter(fixture.dir);
      const wt = await bootstrapWorktree(fixture, adapter, "t1", "backend/t1");
      const wtPath = `${fixture.dir}/.worktrees/backend-t1`;
      await writeManifest(
        fixture.dir,
        manifest(fixture.dir, "t1", { state: "merged", worktreePath: wtPath, lastPrHeadSha: wt.headSha }),
      );
      const tool = createCleanupTool({
        repoRoot: fixture.dir,
        remote: "origin",
        driver: { readPullRequest: async () => ({ number: 7, url: "u", baseRefName: "feature", headRefName: "backend/t1", headSha: wt.headSha, draft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", merged: true, mergedAt: "now" }) },
        repoSlug: "a/b",
        owner: "test",
      });
      const r = await tool({ taskId: "t1" });
      assert.equal(r.kind, "base-mismatch");
    } finally {
      cleanupFixture(fixture);
    }
  });

  test("refuses with dirty-worktree when worktree has uncommitted changes", { serial: true }, async () => {
    const fixture = makeFixtureRepo();
    try {
      const adapter = await loadAdapter(fixture.dir);
      const wt = await bootstrapWorktree(fixture, adapter, "t1", "backend/t1");
      const wtPath = `${fixture.dir}/.worktrees/backend-t1`;
      writeFileSync(`${wtPath}/uncommitted.txt`, "x");
      await writeManifest(
        fixture.dir,
        manifest(fixture.dir, "t1", { state: "merged", worktreePath: wtPath, lastPrHeadSha: wt.headSha }),
      );
      const tool = createCleanupTool({
        repoRoot: fixture.dir,
        remote: "origin",
        driver: { readPullRequest: async () => ({ number: 7, url: "u", baseRefName: "main", headRefName: "backend/t1", headSha: wt.headSha, draft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", merged: true, mergedAt: "now" }) },
        repoSlug: "a/b",
        owner: "test",
      });
      const r = await tool({ taskId: "t1" });
      assert.equal(r.kind, "dirty-worktree");
    } finally {
      cleanupFixture(fixture);
    }
  });
});
