import { test, suite } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import {
  readAbandon,
  hashAbandonIntent,
  publishAbandonIntent,
  publishAbandonCompletion,
} from "../../src/state/abandon-store.js";
import { canonicalJson } from "../../src/installer/json-pointer.js";
import { resolveGitCommonDir } from "../../src/state/git-common-dir.js";

async function makeRepo() {
  const dir = await mkdtemp(resolve(tmpdir(), "abandon-store-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@local",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@local",
  };
  spawnSync("git", ["init", "-b", "main"], { cwd: dir, env });
  spawnSync("git", ["config", "user.email", "test@local"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "test"], { cwd: dir });
  await writeFile(join(dir, "README.md"), "# test\n");
  spawnSync("git", ["add", "README.md"], { cwd: dir, env });
  spawnSync("git", ["commit", "-m", "init"], { cwd: dir, env });
  return dir;
}

function intentRecord(overrides = {}) {
  return {
    schemaVersion: 1,
    taskId: "t1",
    issueNumber: 78,
    prNumber: 79,
    branch: "fix/t1",
    worktreePath: "/tmp/wt",
    headSha: "a".repeat(40),
    workflowId: "wf-78",
    subject: "User approved closing failed acceptance",
    requestedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

suite("abandon store", { concurrency: false }, () => {
  test("paths resolve through git common dir from primary and linked worktree", { serial: true }, async () => {
    const dir = await makeRepo();
    try {
      const wt = join(dir, ".worktrees", "feature");
      await mkdir(join(dir, ".worktrees"), { recursive: true });
      spawnSync("git", ["worktree", "add", "-b", "feature/t1", wt], { cwd: dir });
      const published = await publishAbandonIntent(dir, intentRecord());
      assert.equal(published.ok, true);
      const common = await resolveGitCommonDir(dir);
      const intentPath = join(common, "opencode-ship", "delivery", "abandoned", "t1", "intent.json");
      assert.equal(existsSync(intentPath), true);
      const fromWorktree = await readAbandon(wt, "t1");
      assert.equal(fromWorktree.intent.taskId, "t1");
      assert.equal(fromWorktree.intent.intentHash, published.record.intentHash);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("absent read returns both null", { serial: true }, async () => {
    const dir = await makeRepo();
    try {
      const read = await readAbandon(dir, "missing");
      assert.deepEqual(read, { intent: null, completion: null });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("first intent seals a stable hash and exact retry is idempotent", { serial: true }, async () => {
    const dir = await makeRepo();
    try {
      const record = intentRecord();
      const expectedHash = createHash("sha256").update(canonicalJson(record), "utf8").digest("hex");
      assert.equal(hashAbandonIntent({ ...record, intentHash: "x".repeat(64) }), expectedHash);
      const first = await publishAbandonIntent(dir, record);
      assert.equal(first.ok, true);
      assert.equal(first.idempotent, false);
      assert.equal(first.record.intentHash, expectedHash);
      const retry = await publishAbandonIntent(dir, record);
      assert.equal(retry.ok, true);
      assert.equal(retry.idempotent, true);
      assert.equal(retry.record.intentHash, expectedHash);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("changed subject or identity conflicts and original bytes remain", { serial: true }, async () => {
    const dir = await makeRepo();
    try {
      const original = intentRecord();
      const first = await publishAbandonIntent(dir, original);
      assert.equal(first.ok, true);
      const conflict = await publishAbandonIntent(dir, intentRecord({ subject: "different subject" }));
      assert.equal(conflict.ok, false);
      assert.equal(conflict.kind, "abandon-conflict");
      const common = await resolveGitCommonDir(dir);
      const raw = await readFile(join(common, "opencode-ship", "delivery", "abandoned", "t1", "intent.json"), "utf8");
      const stored = JSON.parse(raw);
      assert.equal(stored.subject, original.subject);
      assert.equal(stored.intentHash, first.record.intentHash);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("completion first write and exact retry succeed; changed hash conflicts", { serial: true }, async () => {
    const dir = await makeRepo();
    try {
      const intent = await publishAbandonIntent(dir, intentRecord());
      const completion = {
        schemaVersion: 1,
        taskId: "t1",
        intentHash: intent.record.intentHash,
        removedWorktree: true,
        deletedBranch: true,
        deletedManifest: true,
        completedAt: "2026-09-01T00:01:00.000Z",
      };
      const first = await publishAbandonCompletion(dir, completion);
      assert.equal(first.ok, true);
      assert.equal(first.idempotent, false);
      const retry = await publishAbandonCompletion(dir, completion);
      assert.equal(retry.ok, true);
      assert.equal(retry.idempotent, true);
      const conflict = await publishAbandonCompletion(dir, {
        ...completion,
        intentHash: "b".repeat(64),
      });
      assert.equal(conflict.ok, false);
      assert.equal(conflict.kind, "abandon-conflict");
      const read = await readAbandon(dir, "t1");
      assert.equal(read.completion.intentHash, intent.record.intentHash);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("unsafe task ids and invalid hashes create no files", { serial: true }, async () => {
    const dir = await makeRepo();
    try {
      const badId = await publishAbandonIntent(dir, intentRecord({ taskId: "../escape" }));
      assert.equal(badId.ok, false);
      assert.equal(badId.kind, "invalid-task-id");
      const badHash = await publishAbandonCompletion(dir, {
        schemaVersion: 1,
        taskId: "t1",
        intentHash: "not-a-hash",
        removedWorktree: true,
        deletedBranch: true,
        deletedManifest: true,
        completedAt: "2026-09-01T00:01:00.000Z",
      });
      assert.equal(badHash.ok, false);
      assert.equal(badHash.kind, "invalid-intent-hash");
      const common = await resolveGitCommonDir(dir);
      assert.equal(existsSync(join(common, "opencode-ship", "delivery", "abandoned")), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
