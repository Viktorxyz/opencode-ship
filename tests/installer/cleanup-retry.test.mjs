import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { tryImmediateCleanup } from "../../src/installer/cleanup.js";
import { readManifest, writeManifest } from "../../src/state/manifest-store.js";
import { cleanupFixture, git, makeFixtureRepo } from "../helpers/fixture.mjs";

test("cleanup retry resumes at branch-delete after worktree removal", async () => {
  const fixture = makeFixtureRepo();
  try {
    const taskId = "cleanup-retry";
    const branch = "fix/cleanup-retry";
    const headSha = git(fixture.dir, ["rev-parse", "HEAD"]).stdout.trim();
    assert.equal(git(fixture.dir, ["branch", branch, headSha]).status, 0);
    await writeManifest(fixture.dir, {
      schemaVersion: 1,
      taskId,
      repoIdentity: "a/b",
      issueNumber: 1,
      prNumber: 7,
      baseBranch: "main",
      baseSha: headSha,
      branch,
      worktreePath: join(fixture.dir, ".worktrees", "cleanup-retry"),
      lastPrHeadSha: headSha,
      lastReviewerSha: headSha,
      lastVerifierSha: headSha,
      owner: "test",
      state: "cleanup-pending",
      transitionLog: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const stateDir = join(fixture.dir, ".git", "opencode-ship");
    await mkdir(stateDir, { recursive: true });
    const pendingPath = join(stateDir, "cleanup-pending.json");
    await writeFile(pendingPath, JSON.stringify([{
      taskId,
      stage: "branch-delete",
      failedAt: new Date().toISOString(),
      reason: "simulated branch deletion failure",
    }], null, 2));

    const result = await tryImmediateCleanup({
      repoRoot: fixture.dir,
      taskId,
      adapter: fixture.adapter,
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.notEqual(git(fixture.dir, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).status, 0);
    assert.equal(await readManifest(fixture.dir, taskId), null);
    assert.deepEqual(JSON.parse(await readFile(pendingPath, "utf8")), []);
  } finally {
    cleanupFixture(fixture);
  }
});

test("cleanup retry preserves a branch that moved after worktree removal", async () => {
  const fixture = makeFixtureRepo();
  try {
    const taskId = "cleanup-moved-branch";
    const branch = "fix/cleanup-moved-branch";
    const expectedHeadSha = git(fixture.dir, ["rev-parse", "HEAD"]).stdout.trim();
    assert.equal(git(fixture.dir, ["branch", branch, expectedHeadSha]).status, 0);
    assert.equal(git(fixture.dir, ["commit", "--allow-empty", "-m", "advance branch"]).status, 0);
    const actualHeadSha = git(fixture.dir, ["rev-parse", "HEAD"]).stdout.trim();
    assert.equal(git(fixture.dir, ["branch", "-f", branch, actualHeadSha]).status, 0);
    await writeManifest(fixture.dir, {
      schemaVersion: 2,
      taskId,
      repoIdentity: "a/b",
      issueNumber: 1,
      prNumber: 7,
      baseBranch: "main",
      baseSha: expectedHeadSha,
      branch,
      worktreePath: join(fixture.dir, ".worktrees", "cleanup-moved-branch"),
      lastPrHeadSha: null,
      lastReviewerSha: expectedHeadSha,
      lastVerifierSha: expectedHeadSha,
      workflowId: null,
      owner: "test",
      state: "cleanup-pending",
      transitionLog: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const stateDir = join(fixture.dir, ".git", "opencode-ship");
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "cleanup-pending.json"), JSON.stringify([{
      taskId,
      stage: "branch-delete",
      expectedHeadSha,
      failedAt: new Date().toISOString(),
      reason: "simulated crash after worktree removal",
    }], null, 2));

    const result = await tryImmediateCleanup({ repoRoot: fixture.dir, taskId, adapter: fixture.adapter });

    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.reason, "branch-delete-failed");
    assert.equal(git(fixture.dir, ["rev-parse", `refs/heads/${branch}`]).stdout.trim(), actualHeadSha);
  } finally {
    cleanupFixture(fixture);
  }
});

test("cleanup retry refuses branch deletion without a validated head", async () => {
  const fixture = makeFixtureRepo();
  try {
    const taskId = "cleanup-missing-head";
    const branch = "fix/cleanup-missing-head";
    const headSha = git(fixture.dir, ["rev-parse", "HEAD"]).stdout.trim();
    assert.equal(git(fixture.dir, ["branch", branch, headSha]).status, 0);
    await writeManifest(fixture.dir, {
      schemaVersion: 2,
      taskId,
      repoIdentity: "a/b",
      issueNumber: 1,
      prNumber: 7,
      baseBranch: "main",
      baseSha: headSha,
      branch,
      worktreePath: join(fixture.dir, ".worktrees", "cleanup-missing-head"),
      lastPrHeadSha: null,
      lastReviewerSha: headSha,
      lastVerifierSha: headSha,
      workflowId: null,
      owner: "test",
      state: "cleanup-pending",
      transitionLog: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const stateDir = join(fixture.dir, ".git", "opencode-ship");
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "cleanup-pending.json"), JSON.stringify([{
      taskId,
      stage: "branch-delete",
      failedAt: new Date().toISOString(),
      reason: "legacy retry without a validated head",
    }], null, 2));

    const result = await tryImmediateCleanup({ repoRoot: fixture.dir, taskId, adapter: fixture.adapter });

    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.reason, "no-head");
    assert.equal(git(fixture.dir, ["rev-parse", `refs/heads/${branch}`]).stdout.trim(), headSha);
  } finally {
    cleanupFixture(fixture);
  }
});

test("cleanup retry clears a manifest-seal orphan", async () => {
  const fixture = makeFixtureRepo();
  try {
    const taskId = "cleanup-manifest-seal";
    const stateDir = join(fixture.dir, ".git", "opencode-ship");
    const pendingPath = join(stateDir, "cleanup-pending.json");
    await mkdir(stateDir, { recursive: true });
    await writeFile(pendingPath, JSON.stringify([{
      taskId,
      stage: "manifest-seal",
      failedAt: new Date().toISOString(),
      reason: "simulated crash after manifest deletion",
    }], null, 2));

    const result = await tryImmediateCleanup({ repoRoot: fixture.dir, taskId, adapter: fixture.adapter });

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.sealed, true);
    assert.deepEqual(JSON.parse(await readFile(pendingPath, "utf8")), []);
  } finally {
    cleanupFixture(fixture);
  }
});
