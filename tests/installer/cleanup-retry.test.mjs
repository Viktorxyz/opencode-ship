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
