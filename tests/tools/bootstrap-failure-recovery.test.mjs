import { test, suite } from "node:test";
import assert from "node:assert/strict";
import { loadAdapter } from "../../src/adapter.js";
import { createIssueTool, createWorktreeTool } from "../../src/index.js";
import { makeFixtureRepo, cleanupFixture, linkWorkflow } from "../helpers/fixture.mjs";
import { readManifest } from "../../src/state/manifest-store.js";

/**
 * Regression tests for bootstrap failure recovery.
 *
 * The v0.1.1 implementation returns a `bootstrap-failed` envelope and
 * leaves the manifest in `issue-linked`, so the recovery scan cannot
 * act on it. After the fix, a failed bootstrap must record a
 * `fatalReason`, transition the manifest to `cleanup-pending`, and
 * remain visible to `scanRecovery`.
 */

suite("bootstrap failure recovery", { concurrency: false }, () => {
  test("failed bootstrap transitions manifest to cleanup-pending with fatalReason", { serial: true }, async () => {
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
        adapter: {
          ...adapter.adapter,
          worktree: {
            ...adapter.adapter.worktree,
            bootstrap: [["false"]],
          },
        },
      });
      const r = await worktree({
        taskId: "t1",
        branch: "backend/t1",
        worktreeRelativePath: ".worktrees/backend-t1",
      });
      assert.equal(r.kind, "bootstrap-failed");

      const m = await readManifest(fixture.dir, "t1");
      assert.equal(m.state, "cleanup-pending");
      assert.match(m.fatalReason ?? "", /bootstrap/);

      const { scanRecovery } = await import("../../src/recovery.js");
      const report = await scanRecovery(fixture.dir);
      assert.ok(
        report.pendingCleanup >= 1 || (report.notes ?? []).some((n) => n.includes("t1")),
        `recovery report must surface the stranded manifest: ${JSON.stringify(report)}`,
      );
    } finally {
      cleanupFixture(fixture);
    }
  });
});
