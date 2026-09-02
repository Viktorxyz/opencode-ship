import { test, suite } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { loadAdapter } from "../../src/adapter.js";
import { createIssueTool, createWorktreeTool } from "../../src/index.js";
import { readManifest, writeManifest } from "../../src/state/manifest-store.js";
import { makeFixtureRepo, cleanupFixture, git } from "../helpers/fixture.mjs";

function stubDriver() {
  return {
    ensureIssue: async () => ({
      summary: { number: 1, url: "https://example/issues/1", state: "OPEN", pullRequest: null },
      created: true,
    }),
  };
}

async function updateManifest(repoRoot, taskId, changes) {
  const manifest = await readManifest(repoRoot, taskId);
  await writeManifest(repoRoot, { ...manifest, ...changes });
}

suite("delivery_worktree", { concurrency: false }, () => {
  test("creates a worktree, runs bootstrap, records manifest", { serial: true }, async () => {
    const fixture = makeFixtureRepo();
    try {
      const adapter = await loadAdapter(fixture.dir);
      const issue = createIssueTool({
        repoRoot: fixture.dir,
        driver: stubDriver(),
        repoSlug: "a/b",
        owner: "test",
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
      await updateManifest(fixture.dir, "t1", { workflowId: "wf-1" });

      const bootstrapMarker = `${fixture.dir}/.opencode/bootstrap-ran`;
      const worktree = createWorktreeTool({
        repoRoot: fixture.dir,
        remote: "origin",
        adapter: { ...adapter.adapter, worktree: { ...adapter.adapter.worktree, bootstrap: [["touch", bootstrapMarker]] } },
      });
      const r = await worktree({
        taskId: "t1",
        branch: "backend/t1",
        worktreeRelativePath: ".worktrees/backend-t1",
      });
      assert.equal(r.contractVersion, 1, `unexpected envelope: ${JSON.stringify(r)}`);
      assert.equal(r.branch, "backend/t1");
      assert.match(r.headSha, /^[0-9a-f]{40}$/);
      const { statSync } = await import("node:fs");
      assert.ok(statSync(bootstrapMarker).isFile(), "bootstrap did not run");
    } finally {
      cleanupFixture(fixture);
    }
  });

  test("refuses when branch already exists locally", { serial: true }, async () => {
    const fixture = makeFixtureRepo();
    try {
      const adapter = await loadAdapter(fixture.dir);
      const issue = createIssueTool({
        repoRoot: fixture.dir,
        driver: stubDriver(),
        repoSlug: "a/b",
        owner: "test",
      });
      await issue({
        taskId: "t2",
        title: "T",
        body: "B",
        baseBranch: "main",
        baseSha: "abc",
        branch: "backend/t2",
        labels: [],
      });
      await updateManifest(fixture.dir, "t2", { workflowId: "wf-2" });
      const worktree = createWorktreeTool({
        repoRoot: fixture.dir,
        remote: "origin",
        adapter: adapter.adapter,
      });
      const r1 = await worktree({
        taskId: "t2",
        branch: "backend/t2",
        worktreeRelativePath: ".worktrees/backend-t2",
      });
      assert.equal(r1.contractVersion, 1);
      const r2 = await worktree({
        taskId: "t2",
        branch: "backend/t2",
        worktreeRelativePath: ".worktrees/backend-t2b",
      });
      assert.equal(r2.kind, "branch-exists-locally");
    } finally {
      cleanupFixture(fixture);
    }
  });

  test("returns manifest-state when manifest is in wrong state", { serial: true }, async () => {
    const fixture = makeFixtureRepo();
    try {
      const adapter = await loadAdapter(fixture.dir);
      const worktree = createWorktreeTool({
        repoRoot: fixture.dir,
        remote: "origin",
        adapter: adapter.adapter,
      });
      const r = await worktree({
        taskId: "never",
        branch: "x/y",
        worktreeRelativePath: ".worktrees/x",
      });
      assert.equal(r.kind, "missing-manifest");
    } finally {
      cleanupFixture(fixture);
    }
  });

  test("refuses a schema-v2 manifest without a workflow link before Git mutation", { serial: true }, async () => {
    const fixture = makeFixtureRepo();
    try {
      const adapter = await loadAdapter(fixture.dir);
      const issue = createIssueTool({
        repoRoot: fixture.dir,
        driver: stubDriver(),
        repoSlug: "a/b",
        owner: "test",
      });
      await issue({
        taskId: "unlinked",
        title: "T",
        body: "B",
        baseBranch: "main",
        baseSha: "abc",
        branch: "backend/unlinked",
        labels: [],
      });
      const worktreePath = `${fixture.dir}/.worktrees/backend-unlinked`;
      const worktree = createWorktreeTool({
        repoRoot: fixture.dir,
        remote: "origin",
        adapter: adapter.adapter,
      });

      const result = await worktree({
        taskId: "unlinked",
        branch: "backend/unlinked",
        worktreeRelativePath: ".worktrees/backend-unlinked",
      });

      assert.deepEqual(result, { kind: "missing-workflow-link", taskId: "unlinked" });
      assert.notEqual(git(fixture.dir, ["show-ref", "--verify", "refs/heads/backend/unlinked"]).status, 0);
      assert.equal(existsSync(worktreePath), false);
    } finally {
      cleanupFixture(fixture);
    }
  });

  test("keeps schema-v1 worktree creation compatible without a workflow link", { serial: true }, async () => {
    const fixture = makeFixtureRepo();
    try {
      const adapter = await loadAdapter(fixture.dir);
      const issue = createIssueTool({
        repoRoot: fixture.dir,
        driver: stubDriver(),
        repoSlug: "a/b",
        owner: "test",
      });
      await issue({
        taskId: "legacy",
        title: "T",
        body: "B",
        baseBranch: "main",
        baseSha: "abc",
        branch: "backend/legacy",
        labels: [],
      });
      await updateManifest(fixture.dir, "legacy", { schemaVersion: 1, workflowId: null });
      const worktree = createWorktreeTool({
        repoRoot: fixture.dir,
        remote: "origin",
        adapter: adapter.adapter,
      });

      const result = await worktree({
        taskId: "legacy",
        branch: "backend/legacy",
        worktreeRelativePath: ".worktrees/backend-legacy",
      });

      assert.equal(result.contractVersion, 1, `unexpected envelope: ${JSON.stringify(result)}`);
      assert.equal(result.branch, "backend/legacy");
    } finally {
      cleanupFixture(fixture);
    }
  });

  test("fails when bootstrap argv is invalid", { serial: true }, async () => {
    const fixture = makeFixtureRepo();
    try {
      const adapter = await loadAdapter(fixture.dir);
      const issue = createIssueTool({
        repoRoot: fixture.dir,
        driver: stubDriver(),
        repoSlug: "a/b",
        owner: "test",
      });
      await issue({
        taskId: "t3",
        title: "T",
        body: "B",
        baseBranch: "main",
        baseSha: "abc",
        branch: "backend/t3",
        labels: [],
      });
      await updateManifest(fixture.dir, "t3", { workflowId: "wf-3" });
      const worktree = createWorktreeTool({
        repoRoot: fixture.dir,
        remote: "origin",
        adapter: { ...adapter.adapter, worktree: { ...adapter.adapter.worktree, bootstrap: [[]] } },
      });
      const r = await worktree({
        taskId: "t3",
        branch: "backend/t3",
        worktreeRelativePath: ".worktrees/backend-t3",
      });
      assert.equal(r.kind, "bootstrap-invalid");
    } finally {
      cleanupFixture(fixture);
    }
  });
});
