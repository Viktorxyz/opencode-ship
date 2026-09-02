import { test, suite } from "node:test";
import assert from "node:assert/strict";
import { loadAdapter } from "../../src/adapter.js";
import { createIssueTool, createWorktreeTool, createPrTool } from "../../src/index.js";
import { makeFixtureRepo, cleanupFixture, linkWorkflow } from "../helpers/fixture.mjs";
import { writeManifest, readManifest } from "../../src/state/manifest-store.js";

/**
 * Regression tests for delivery_pr body preservation.
 *
 * The v0.1.1 implementation overwrites the PR body verbatim on every
 * refresh. When the caller forgets to include `Closes #N` in a
 * follow-up body, the closing line is dropped. The fix merges the
 * existing closing reference into the new body when missing.
 */

suite("delivery_pr body preservation", { concurrency: false }, () => {
  test("preserves Closes #N across body refresh even when omitted", { serial: true }, async () => {
    const fixture = makeFixtureRepo();
    try {
      const adapter = await loadAdapter(fixture.dir);
      const issue = createIssueTool({
        repoRoot: fixture.dir,
        driver: {
          ensureIssue: async () => ({
            summary: { number: 19, url: "u", state: "OPEN", pullRequest: null },
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
      await worktree({
        taskId: "t1",
        branch: "backend/t1",
        worktreeRelativePath: ".worktrees/backend-t1",
      });

      const pr = createPrTool({
        repoRoot: fixture.dir,
        driver: {
          openDraftPullRequest: async () => ({
            number: 11,
            url: "u",
            baseRefName: "main",
            headRefName: "backend/t1",
            headSha: "abc",
            draft: true,
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            merged: false,
            mergedAt: null,
          }),
          updatePullRequestBody: async () => undefined,
          refreshHead: async () => "abc",
        },
        repoSlug: "a/b",
        owner: "test",
        adapter: adapter.adapter,
      });
      const open = await pr({
        taskId: "t1",
        title: "T",
        body: "Initial body\n\nCloses #19",
      });
      assert.equal(open.contractVersion, 1, JSON.stringify(open));

      const captured = { bodies: [] };
      const pr2 = createPrTool({
        repoRoot: fixture.dir,
        driver: {
          openDraftPullRequest: async () => {
            throw new Error("should not be called on refresh");
          },
          updatePullRequestBody: async ({ body }) => {
            captured.bodies.push(body);
          },
          refreshHead: async () => "abc",
          readPullRequest: async () => ({
            number: 11,
            url: "https://example.com/pr/11",
            baseRefName: "main",
            headRefName: "backend/t1",
            headSha: "abc",
            draft: true,
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            merged: false,
            mergedAt: null,
          }),
        },
        repoSlug: "a/b",
        owner: "test",
        adapter: adapter.adapter,
      });
      const refresh = await pr2({
        taskId: "t1",
        title: "T",
        body: "Refreshed without the closing line",
      });
      assert.equal(refresh.contractVersion, 1, JSON.stringify(refresh));
      assert.equal(captured.bodies.length, 1);
      assert.match(captured.bodies[0], /Closes #19/, `body must retain the closing line, got: ${captured.bodies[0]}`);

      const m = await readManifest(fixture.dir, "t1");
      assert.equal(m.prNumber, 11);
    } finally {
      cleanupFixture(fixture);
    }
  });
});
