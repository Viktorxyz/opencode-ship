import { test, suite } from "node:test";
import assert from "node:assert/strict";
import { loadAdapter } from "../../src/adapter.js";
import { createIssueTool } from "../../src/tools/delivery-issue.js";
import { createWorktreeTool } from "../../src/tools/delivery-worktree.js";
import { makeFixtureRepo, cleanupFixture, linkWorkflow } from "../helpers/fixture.mjs";
import { readManifest } from "../../src/state/manifest-store.js";

/**
 * Regression tests for delivery_issue idempotency.
 *
 * The v0.1.1 implementation re-creates the manifest on every call,
 * discarding the recorded lastReviewerSha / lastVerifierSha history.
 * After draft-open (or any later state) a second delivery_issue call
 * must leave the existing manifest untouched and return the same
 * `issueNumber`.
 */

suite("delivery_issue idempotency", { concurrency: false }, () => {
  test("second call after draft-open does not reset the manifest", { serial: true }, async () => {
    const fixture = makeFixtureRepo();
    try {
      const adapter = await loadAdapter(fixture.dir);
      let ensureCalls = 0;
      const driver = {
        ensureIssue: async () => {
          ensureCalls++;
          return {
            summary: {
              number: 17,
              url: "https://example/issues/17",
              state: "OPEN",
              pullRequest: null,
            },
            created: ensureCalls === 1,
          };
        },
      };
      const issue = createIssueTool({
        repoRoot: fixture.dir,
        driver,
        repoSlug: "a/b",
        owner: "test",
        adapter: adapter.adapter,
      });
      const first = await issue({
        taskId: "t1",
        title: "T",
        body: "B",
        baseBranch: "main",
        baseSha: "abc",
        branch: "backend/t1",
        labels: [],
      });
      assert.equal(first.kind, undefined);
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
      assert.equal(wt.contractVersion, 1, JSON.stringify(wt));

      const seedReviewSha = "rev-sha-1";
      const seedVerifySha = "ver-sha-1";
      const manifest = await readManifest(fixture.dir, "t1");
      manifest.lastReviewerSha = seedReviewSha;
      manifest.lastVerifierSha = seedVerifySha;
      manifest.lastPrHeadSha = "abc";
      manifest.prNumber = 7;
      manifest.state = "draft-open";
      manifest.transitionLog.push({
        from: "issue-linked",
        to: "draft-open",
        at: Date.now(),
        reason: "synthetic",
      });
      const { writeManifest } = await import("../../src/state/manifest-store.js");
      await writeManifest(fixture.dir, manifest);

      const second = await issue({
        taskId: "t1",
        title: "T",
        body: "B",
        baseBranch: "main",
        baseSha: "abc",
        branch: "backend/t1",
        labels: [],
      });
      assert.equal(second.kind, undefined);
      assert.equal(second.issueNumber, 17);
      assert.equal(second.created, false, "second call must reuse, not create");

      const after = await readManifest(fixture.dir, "t1");
      assert.equal(after.state, "draft-open", "state must remain unchanged");
      assert.equal(after.prNumber, 7);
      assert.equal(after.lastReviewerSha, seedReviewSha, "reviewer SHA must survive");
      assert.equal(after.lastVerifierSha, seedVerifySha, "verifier SHA must survive");
      assert.equal(after.issueNumber, 17);
    } finally {
      cleanupFixture(fixture);
    }
  });
});
