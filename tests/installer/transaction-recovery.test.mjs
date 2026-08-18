import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { executePlan } from "../../src/installer/transaction.js";
import { bytesHashString } from "../../src/installer/hash.js";
import { makeProject, cleanProject } from "../fixtures/installer-fixture.mjs";

test("transaction recovery removes a newly-created file after a crash", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));

  const target = join(repoRoot, ".opencode", "plugins", "opencode-ship.js");
  await mkdir(join(repoRoot, ".opencode", "plugins"), { recursive: true });
  await writeFile(target, "new bytes\n");

  const transactionDir = join(repoRoot, ".git", "opencode-ship");
  await mkdir(transactionDir, { recursive: true });
  const journalPath = join(transactionDir, ".txn-crash.journal");
  await writeFile(journalPath, JSON.stringify({
    repoRoot,
    txnId: "crash",
    ledger: [{
      op: "write",
      target,
      backup: null,
      staged: null,
      hadOriginal: false,
      mode: 0o644,
    }],
  }));

  const result = await executePlan({ repoRoot, plan: [], newLockBuilder: null });

  assert.equal(result.ok, true);
  assert.equal(result.recovered, true);
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(journalPath), false);
});

test("transaction failure rolls back files written before the failure", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));

  const firstTarget = join(repoRoot, "first.txt");
  const blockingParent = join(repoRoot, "blocking-file");
  await writeFile(firstTarget, "original\n");
  await writeFile(blockingParent, "not a directory\n");

  const result = await executePlan({
    repoRoot,
    plan: [
      { op: "file", kind: "update", target: firstTarget, bytes: Buffer.from("replacement\n"), mode: 0o644 },
      { op: "file", kind: "create", target: join(blockingParent, "child.txt"), bytes: Buffer.from("never written\n"), mode: 0o644 },
    ],
    newLockBuilder: null,
  });

  assert.equal(result.ok, false);
  assert.equal(await readFile(firstTarget, "utf8"), "original\n");
  const leftovers = (await readdir(repoRoot)).filter((name) => name.includes(".txn-"));
  assert.deepEqual(leftovers, []);
});

test("transaction failure restores a deleted setup marker before lock promotion", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  const marker = join(repoRoot, ".opencode", "ship.setup-pending.json");
  await mkdir(join(repoRoot, ".opencode"), { recursive: true });
  await writeFile(marker, "{\"pending\":true}\n");
  const result = await executePlan({
    repoRoot,
    plan: [{ op: "file", kind: "delete", target: marker, relPath: ".opencode/ship.setup-pending.json" }],
    newLockBuilder: async () => { throw new Error("lock promotion failed"); },
  });
  assert.equal(result.ok, false);
  assert.equal(await readFile(marker, "utf8"), "{\"pending\":true}\n");
});

test("transaction recovery treats the promoted lock as the commit marker", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));

  const target = join(repoRoot, ".opencode", "ship.lock.json");
  const backup = `${target}.txn-crash-backup`;
  await mkdir(join(repoRoot, ".opencode"), { recursive: true });
  await writeFile(target, "committed\n");
  await writeFile(backup, "original\n");

  const transactionDir = join(repoRoot, ".git", "opencode-ship");
  await mkdir(transactionDir, { recursive: true });
  await writeFile(join(transactionDir, ".txn-crash.journal"), JSON.stringify({
    repoRoot,
    txnId: "crash",
    committed: false,
    ledger: [{
      op: "write",
      target,
      backup,
      staged: null,
      hadOriginal: true,
      commitMarker: true,
      installedSha256: bytesHashString("committed\n"),
      mode: 0o644,
    }],
  }));

  const result = await executePlan({ repoRoot, plan: [], newLockBuilder: null });

  assert.equal(result.ok, true);
  assert.equal(await readFile(target, "utf8"), "committed\n");
  assert.equal(existsSync(backup), false);
});

test("transaction recovery does not roll back a live transaction", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));

  const target = join(repoRoot, "active.txt");
  await writeFile(target, "in progress\n");

  const transactionDir = join(repoRoot, ".git", "opencode-ship");
  await mkdir(transactionDir, { recursive: true });
  await writeFile(join(transactionDir, ".txn.lock"), JSON.stringify({
    pid: process.pid,
    txnId: "active",
    startedAt: new Date().toISOString(),
  }));
  await writeFile(join(transactionDir, ".txn-active.journal"), JSON.stringify({
    repoRoot,
    txnId: "active",
    ledger: [{
      op: "write",
      target,
      backup: null,
      staged: null,
      hadOriginal: false,
      mode: 0o644,
    }],
  }));

  const result = await executePlan({ repoRoot, plan: [], newLockBuilder: null });

  assert.equal(result.ok, false);
  assert.equal(result.error.kind, "lock-held");
  assert.equal(await readFile(target, "utf8"), "in progress\n");
  assert.equal(existsSync(join(transactionDir, ".txn-active.journal")), true);
});

test("transaction recovery clears a stale lock before replaying the journal", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));

  const target = join(repoRoot, "stale.txt");
  await writeFile(target, "partial write\n");

  const transactionDir = join(repoRoot, ".git", "opencode-ship");
  const lockPath = join(transactionDir, ".txn.lock");
  const journalPath = join(transactionDir, ".txn-stale.journal");
  await mkdir(transactionDir, { recursive: true });
  await writeFile(lockPath, JSON.stringify({
    pid: 2_147_483_647,
    txnId: "stale",
    startedAt: new Date(0).toISOString(),
  }));
  await writeFile(journalPath, JSON.stringify({
    repoRoot,
    txnId: "stale",
    ledger: [{
      op: "write",
      target,
      backup: null,
      staged: null,
      hadOriginal: false,
      mode: 0o644,
    }],
  }));

  const result = await executePlan({ repoRoot, plan: [], newLockBuilder: null });

  assert.equal(result.ok, true);
  assert.equal(result.recovered, true);
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(journalPath), false);
  assert.equal(existsSync(lockPath), false);
});
