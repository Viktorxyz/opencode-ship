import { test, suite } from "node:test";
import assert from "node:assert/strict";
import { loadAdapter } from "../../src/adapter.js";
import { createIssueTool, createWorktreeTool, createVerifyTool } from "../../src/index.js";
import { makeFixtureRepo, cleanupFixture, linkWorkflow } from "../helpers/fixture.mjs";

/**
 * Regression test for delivery_verify manifestPath correctness.
 *
 * The v0.1.1 implementation returns the adapter path
 * (`.opencode/delivery.json`) as `manifestPath`. The correct value
 * is the manifest file path the tool just wrote under the
 * git-common-dir (typically
 * `<commonDir>/opencode-ship/delivery/manifests/<taskId>.json`).
 */

suite("delivery_verify manifestPath", { concurrency: false }, () => {
  test("returns the actual manifest file path", { serial: true }, async () => {
    const fixture = makeFixtureRepo();
    try {
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
      const wt = await worktree({
        taskId: "t1",
        branch: "backend/t1",
        worktreeRelativePath: ".worktrees/backend-t1",
      });
      const verify = createVerifyTool({
        repoRoot: fixture.dir,
        adapter: adapter.adapter,
      });
      const r = await verify({ taskId: "t1", commandId: "canonical" });
      assert.equal(r.contractVersion, 1, JSON.stringify(r));
      assert.match(
        r.manifestPath,
        /opencode-ship\/delivery\/manifests\/t1\.json$/,
        `manifestPath must point at the manifest file, got: ${r.manifestPath}`,
      );
      assert.notEqual(
        r.manifestPath,
        `${fixture.dir}/.opencode/delivery.json`,
        "manifestPath must NOT be the adapter path",
      );
    } finally {
      cleanupFixture(fixture);
    }
  });
});
