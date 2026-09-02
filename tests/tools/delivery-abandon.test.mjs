import { test, suite } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { createAbandonTool } from "../../src/tools/delivery-abandon.js";
import { writeManifest, readManifest } from "../../src/state/manifest-store.js";
import { readAbandon } from "../../src/state/abandon-store.js";
import { makeFixtureRepo, cleanupFixture, git } from "../helpers/fixture.mjs";

function closedPr(headSha, overrides = {}) {
  return {
    number: 79,
    url: "u",
    baseRefName: "main",
    headRefName: "fix/t1",
    headSha,
    draft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    state: "CLOSED",
    merged: false,
    mergedAt: null,
    ...overrides,
  };
}

async function seedAttempt(overrides = {}) {
  const fixture = makeFixtureRepo();
  const branch = overrides.branch ?? "fix/t1";
  const wtRel = `.worktrees/${branch.replace("/", "-")}`;
  const wtPath = join(fixture.dir, wtRel);
  mkdirSync(join(fixture.dir, ".worktrees"), { recursive: true });
  const added = git(fixture.dir, ["worktree", "add", "-b", branch, wtPath]);
  assert.equal(added.status, 0, added.stderr);
  const head = git(wtPath, ["rev-parse", "HEAD"]).stdout.trim();
  const now = new Date().toISOString();
  const manifest = {
    schemaVersion: 2,
    taskId: "t1",
    repoIdentity: "a/b",
    issueNumber: 78,
    prNumber: 79,
    baseBranch: "main",
    baseSha: head,
    branch,
    worktreePath: wtPath,
    lastPrHeadSha: head,
    lastReviewerSha: null,
    lastVerifierSha: null,
    workflowId: null,
    owner: "test",
    state: "validating",
    transitionLog: [],
    createdAt: now,
    updatedAt: now,
    ...overrides.manifest,
  };
  if (overrides.manifest?.worktreePath === undefined) manifest.worktreePath = wtPath;
  if (overrides.manifest?.lastPrHeadSha === undefined) manifest.lastPrHeadSha = head;
  await writeManifest(fixture.dir, manifest);
  return { fixture, wtPath, head, branch, manifest };
}

function toolFor(fixture, pr, extras = {}) {
  return createAbandonTool({
    repoRoot: fixture.dir,
    repoSlug: "a/b",
    remote: "origin",
    driver: { readPullRequest: async () => pr },
    ...extras,
  });
}

suite("delivery_abandon", { concurrency: false }, () => {
  test("refuses missing manifest, input, pr, and worktree without writing intent", { serial: true }, async () => {
    const { fixture, wtPath, head } = await seedAttempt();
    try {
      const missing = await toolFor(fixture, closedPr(head))({ taskId: "missing", subject: "close it" });
      assert.equal(missing.details.kind, "missing-manifest");
      const noSubject = await toolFor(fixture, closedPr(head))({ taskId: "t1", subject: "   " });
      assert.equal(noSubject.details.kind, "missing-input");
      await writeManifest(fixture.dir, { ...(await readManifest(fixture.dir, "t1")), prNumber: null });
      const noPr = await toolFor(fixture, closedPr(head))({ taskId: "t1", subject: "close it" });
      assert.equal(noPr.details.kind, "missing-pr");
      await writeManifest(fixture.dir, { ...(await readManifest(fixture.dir, "t1")), prNumber: 79, worktreePath: null });
      const noWt = await toolFor(fixture, closedPr(head))({ taskId: "t1", subject: "close it" });
      assert.equal(noWt.details.kind, "missing-worktree-path");
      assert.equal((await readAbandon(fixture.dir, "t1")).intent, null);
      assert.equal(existsSync(wtPath), true);
    } finally {
      cleanupFixture(fixture);
    }
  });

  test("refuses open and merged pull requests", { serial: true }, async () => {
    const { fixture, wtPath, head } = await seedAttempt();
    try {
      const open = await toolFor(fixture, closedPr(head, { state: "OPEN" }))({ taskId: "t1", subject: "close it" });
      assert.equal(open.details.kind, "pr-open");
      const merged = await toolFor(fixture, closedPr(head, { state: "MERGED", merged: true, mergedAt: "now" }))({
        taskId: "t1",
        subject: "close it",
      });
      assert.equal(merged.details.kind, "pr-merged");
      assert.equal(existsSync(wtPath), true);
      assert.ok(await readManifest(fixture.dir, "t1"));
      assert.equal((await readAbandon(fixture.dir, "t1")).intent, null);
    } finally {
      cleanupFixture(fixture);
    }
  });

  test("refuses identity, dirty, and unpublished mismatches", { serial: true }, async () => {
    const { fixture, wtPath, head, branch } = await seedAttempt();
    try {
      const branchMismatch = await toolFor(fixture, closedPr(head, { headRefName: "other" }))({
        taskId: "t1",
        subject: "close it",
      });
      assert.equal(branchMismatch.details.kind, "branch-mismatch");
      const baseMismatch = await toolFor(fixture, closedPr(head, { baseRefName: "dev" }))({
        taskId: "t1",
        subject: "close it",
      });
      assert.equal(baseMismatch.details.kind, "base-mismatch");
      const headMismatch = await toolFor(fixture, closedPr("b".repeat(40)))({
        taskId: "t1",
        subject: "close it",
      });
      assert.equal(headMismatch.details.kind, "head-mismatch");
      writeFileSync(join(wtPath, "dirty.txt"), "x");
      const dirty = await toolFor(fixture, closedPr(head))({ taskId: "t1", subject: "close it" });
      assert.equal(dirty.details.kind, "dirty-worktree");
      rmSync(join(wtPath, "dirty.txt"));
      git(fixture.dir, ["update-ref", `refs/remotes/origin/${branch}`, head]);
      git(fixture.dir, ["remote", "add", "origin", join(fixture.dir, "missing.git")]);
      writeFileSync(join(wtPath, "ahead.txt"), "y\n");
      git(wtPath, ["add", "ahead.txt"]);
      git(wtPath, ["commit", "-qm", "unpublished"]);
      const unpublishedHead = git(wtPath, ["rev-parse", "HEAD"]).stdout.trim();
      await writeManifest(fixture.dir, { ...(await readManifest(fixture.dir, "t1")), lastPrHeadSha: unpublishedHead });
      const unpublished = await toolFor(fixture, closedPr(unpublishedHead))({
        taskId: "t1",
        subject: "close it",
      });
      assert.equal(unpublished.details.kind, "has-unpublished-commits");
      assert.equal((await readAbandon(fixture.dir, "t1")).intent, null);
    } finally {
      cleanupFixture(fixture);
    }
  });

  test("refuses Ready and merged durable runs", { serial: true }, async () => {
    const { fixture, head } = await seedAttempt({
      manifest: { workflowId: "wf-78" },
    });
    try {
      const common = join(fixture.dir, ".git", "opencode-ship", "runs", "wf-78");
      mkdirSync(common, { recursive: true });
      writeFileSync(join(common, "run.json"), JSON.stringify({ state: "ready" }));
      const ready = await toolFor(fixture, closedPr(head))({ taskId: "t1", subject: "close it" });
      assert.equal(ready.details.kind, "workflow-ready");
      writeFileSync(join(common, "run.json"), JSON.stringify({ state: "merged" }));
      const merged = await toolFor(fixture, closedPr(head))({ taskId: "t1", subject: "close it" });
      assert.equal(merged.details.kind, "workflow-merged");
      assert.equal((await readAbandon(fixture.dir, "t1")).intent, null);
    } finally {
      cleanupFixture(fixture);
    }
  });

  test("successful abandon writes intent before cleanup and completion after", { serial: true }, async () => {
    const { fixture, wtPath, head, branch } = await seedAttempt();
    try {
      const result = await toolFor(fixture, closedPr(head))({
        taskId: "t1",
        subject: "User approved closing failed acceptance",
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.data.removedWorktree, true);
      assert.equal(result.data.deletedBranch, true);
      assert.equal(result.data.deletedManifest, true);
      assert.equal(existsSync(wtPath), false);
      assert.equal(git(fixture.dir, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).status, 1);
      assert.equal(await readManifest(fixture.dir, "t1"), null);
      const stored = await readAbandon(fixture.dir, "t1");
      assert.equal(stored.intent.subject, "User approved closing failed acceptance");
      assert.equal(stored.completion.intentHash, stored.intent.intentHash);
    } finally {
      cleanupFixture(fixture);
    }
  });

  test("partial failures resume from sealed intent to one completion", { serial: true }, async () => {
    const { fixture, wtPath, head, branch } = await seedAttempt();
    try {
      const failRemove = await toolFor(fixture, closedPr(head), {
        removeWorktree: async () => {
          throw new Error("injected remove failure");
        },
      })({ taskId: "t1", subject: "User approved closing failed acceptance" });
      assert.equal(failRemove.ok, false);
      assert.ok((await readAbandon(fixture.dir, "t1")).intent);
      assert.equal(existsSync(wtPath), true);

      const failBranch = await toolFor(fixture, closedPr(head), {
        deleteBranch: async () => ({ status: 1, stderr: "injected branch failure" }),
      })({ taskId: "t1", subject: "User approved closing failed acceptance" });
      assert.equal(failBranch.details.kind, "branch-delete-failed");
      assert.equal(existsSync(wtPath), false);
      assert.equal(git(fixture.dir, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).status, 0);

      const done = await toolFor(fixture, closedPr(head))({
        taskId: "t1",
        subject: "User approved closing failed acceptance",
      });
      assert.equal(done.ok, true, JSON.stringify(done));
      assert.equal(await readManifest(fixture.dir, "t1"), null);
      assert.equal(git(fixture.dir, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).status, 1);
      const retry = await toolFor(fixture, closedPr(head))({
        taskId: "t1",
        subject: "User approved closing failed acceptance",
      });
      assert.equal(retry.ok, true);
      assert.equal(retry.idempotent, true);
    } finally {
      cleanupFixture(fixture);
    }
  });

  test("conflicting retry subject fails", { serial: true }, async () => {
    const { fixture, head } = await seedAttempt();
    try {
      await toolFor(fixture, closedPr(head), {
        removeWorktree: async () => {
          throw new Error("stop after intent");
        },
      })({ taskId: "t1", subject: "original" });
      const conflict = await toolFor(fixture, closedPr(head))({ taskId: "t1", subject: "changed" });
      assert.equal(conflict.details.kind, "abandon-conflict");
    } finally {
      cleanupFixture(fixture);
    }
  });
});
