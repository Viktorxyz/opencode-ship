import { test, suite } from "node:test";
import assert from "node:assert/strict";
import { loadAdapter } from "../../src/adapter.js";
import { createReadyTool, createMergeTool, createVerifyTool, createIssueTool, createWorktreeTool, createPrTool, createReviewTool } from "../../src/index.js";
import { writeManifest } from "../../src/state/manifest-store.js";
import { makeFixtureRepo, cleanupFixture, git, linkWorkflow } from "../helpers/fixture.mjs";

/**
 * Regression tests for delivery_ready / delivery_merge readChecks argv.
 *
 * The v0.1.2 factories call `driver.readChecks({ sha })`. The production
 * `gh pr checks <sha>` CLI rejects commit SHAs: it expects a PR
 * identity (number / branch / URL). The fix must thread
 * `number: m.prNumber` (or the recorded branch) from the manifest into
 * the driver call so the gate consults the right PR.
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
    worktreePath: null,
    lastPrHeadSha: "headSha",
    lastReviewerSha: "headSha",
    lastVerifierSha: "headSha",
    owner: "test",
    state: "validating",
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

suite("delivery_ready forwards PR identity to readChecks", { concurrency: false }, () => {
  test("calls driver.readChecks with number=prNumber, not just sha", { serial: true }, async () => {
    const fixture = makeFixtureRepo();
    try {
      await bootstrapMergedWorktree(fixture);
      await writeManifest(
        fixture.dir,
        manifest(fixture.dir, "t1", {
          state: "validating",
          lastPrHeadSha: "headSha",
          lastReviewerSha: "headSha",
          lastVerifierSha: "headSha",
        }),
      );
      const calls = [];
      const driver = {
        refreshHead: async () => "headSha",
        readChecks: async (args) => {
          calls.push(args);
          return [{ name: "delivery-verify", state: "success", bucket: "pass" }];
        },
        markReady: async () => ({}),
      };
      const ready = createReadyTool({
        repoRoot: fixture.dir,
        repoSlug: "a/b",
        adapter: (await loadAdapter(fixture.dir)).adapter,
        driver,
      });
      await ready({ taskId: "t1" });
      assert.ok(calls.length > 0, "readChecks must be called");
      assert.equal(calls[0].number, 7, `expected number=7, got ${calls[0].number}`);
      assert.ok(
        calls[0].number != null || (typeof calls[0].branch === "string" && calls[0].branch.length > 0),
        `readChecks must receive a PR identity, not just sha. got ${JSON.stringify(calls[0])}`,
      );
    } finally {
      cleanupFixture(fixture);
    }
  });
});

suite("delivery_merge forwards PR identity to readChecks", { concurrency: false }, () => {
  test("calls driver.readChecks with number=prNumber when gates are re-checked", { serial: true }, async () => {
    const fixture = makeFixtureRepo();
    try {
      await bootstrapMergedWorktree(fixture);
      await writeManifest(
        fixture.dir,
        manifest(fixture.dir, "t1", {
          state: "ready",
          lastPrHeadSha: "headSha",
          lastReviewerSha: "headSha",
          lastVerifierSha: "headSha",
        }),
      );
      const calls = [];
      const driver = {
        readPullRequest: async () => ({
          number: 7,
          url: "u",
          baseRefName: "main",
          headRefName: "backend/t1",
          headSha: "headSha",
          draft: false,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          merged: false,
          mergedAt: null,
        }),
        readChecks: async (args) => {
          calls.push(args);
          return [{ name: "delivery-verify", state: "success", bucket: "pass" }];
        },
        mergePullRequest: async () => ({
          number: 7,
          url: "u",
          baseRefName: "main",
          headRefName: "backend/t1",
          headSha: "headSha",
          draft: false,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          merged: true,
          mergedAt: "now",
        }),
      };
      const merge = createMergeTool({
        repoRoot: fixture.dir,
        repoSlug: "a/b",
        adapter: (await loadAdapter(fixture.dir)).adapter,
        driver,
      });
      await merge({ taskId: "t1", subject: "test (#1)" });
      assert.ok(calls.length > 0, "readChecks must be called when freshGates is true");
      assert.equal(calls[0].number, 7, `expected number=7, got ${calls[0].number}`);
    } finally {
      cleanupFixture(fixture);
    }
  });
});
