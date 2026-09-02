import { test, suite } from "node:test";
import assert from "node:assert/strict";
import { loadAdapter } from "../../src/adapter.js";
import { createIssueTool, createWorktreeTool, createVerifyTool } from "../../src/index.js";
import { makeFixtureRepo, cleanupFixture, git, linkWorkflow } from "../helpers/fixture.mjs";

function stubDriver() {
  return {
    ensureIssue: async () => ({
      summary: { number: 1, url: "u", state: "OPEN", pullRequest: null },
      created: true,
    }),
  };
}

async function bootstrapIssueWorktree(fixture, adapter) {
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

suite("delivery_verify", { concurrency: false }, () => {
  test("succeeds on clean worktree and records verifier SHA", { serial: true }, async () => {
    const fixture = makeFixtureRepo({
      verification: {
        commands: [{ id: "canonical", argv: ["true"], timeoutMs: 5000 }],
        requireCleanDiffAfter: true,
      },
    });
    try {
      const adapter = await loadAdapter(fixture.dir);
      const wt = await bootstrapIssueWorktree(fixture, adapter);
      const verify = createVerifyTool({
        repoRoot: fixture.dir,
        adapter: adapter.adapter,
      });
      const r = await verify({ taskId: "t1", commandId: "canonical" });
      assert.equal(r.contractVersion, 1, `unexpected envelope: ${JSON.stringify(r)}`);
      assert.equal(r.status, 0);
      assert.equal(r.commandId, "canonical");
      assert.equal(r.headSha, wt.headSha);
    } finally {
      cleanupFixture(fixture);
    }
  });

  test("rejects when worktree is dirty", { serial: true }, async () => {
    const fixture = makeFixtureRepo({
      verification: {
        commands: [{ id: "canonical", argv: ["true"], timeoutMs: 5000 }],
        requireCleanDiffAfter: true,
      },
    });
    try {
      const adapter = await loadAdapter(fixture.dir);
      const wt = await bootstrapIssueWorktree(fixture, adapter);
      const wtPath = `${fixture.dir}/.worktrees/backend-t1`;
      const { writeFileSync } = await import("node:fs");
      writeFileSync(`${wtPath}/uncommitted`, "x");
      const verify = createVerifyTool({
        repoRoot: fixture.dir,
        adapter: adapter.adapter,
      });
      const r = await verify({ taskId: "t1", commandId: "canonical" });
      assert.equal(r.kind, "worktree-dirty");
    } finally {
      cleanupFixture(fixture);
    }
  });

  test("returns verify-failed when the command exits non-zero", { serial: true }, async () => {
    const fixture = makeFixtureRepo({
      verification: {
        commands: [{ id: "fail", argv: ["false"], timeoutMs: 5000 }],
        requireCleanDiffAfter: false,
      },
    });
    try {
      const adapter = await loadAdapter(fixture.dir);
      const wt = await bootstrapIssueWorktree(fixture, adapter);
      const verify = createVerifyTool({
        repoRoot: fixture.dir,
        adapter: adapter.adapter,
      });
      const r = await verify({ taskId: "t1", commandId: "fail" });
      assert.equal(r.kind, "verify-failed");
      assert.equal(r.status, 1);
      assert.equal(r.headSha, wt.headSha);
    } finally {
      cleanupFixture(fixture);
    }
  });

  test("returns no-commands when verification list is empty", { serial: true }, async () => {
    const fixture = makeFixtureRepo({
      verification: { commands: [], requireCleanDiffAfter: false },
    });
    try {
      const adapter = await loadAdapter(fixture.dir);
      await bootstrapIssueWorktree(fixture, adapter);
      const verify = createVerifyTool({
        repoRoot: fixture.dir,
        adapter: adapter.adapter,
      });
      const r = await verify({ taskId: "t1", commandId: "x" });
      assert.equal(r.kind, "no-commands");
    } finally {
      cleanupFixture(fixture);
    }
  });
});
