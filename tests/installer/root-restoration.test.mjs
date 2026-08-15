/*
 * v3 lock schema + reversible root-pointer restoration tests.
 *
 * These tests guard the contract that:
 *   - the lock carries a `scope` field per root pointer so the
 *     installer knows which pointers to keep during a profile
 *     transition and which to restore on uninstall;
 *   - engineering -> core removes the engineering-scoped Plan Mode
 *     permission block and restores the prior core pointer values;
 *   - core -> engineering -> core -> engineering -> uninstall ends
 *     with the preinstall root configuration byte-identical to the
 *     original;
 *   - lock deletion is performed inside the transaction layer so a
 *     crash mid-uninstall leaves a recoverable journal.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";

import {
  CURRENT_LOCK_SCHEMA,
  lockPath,
  readLock,
  validateLock,
  computeIntegrity,
} from "../../src/installer/lock.js";
import {
  applyPlanModeOwnership,
  findRootConfig,
  readRootConfig,
  applyOwnedPointers,
  POINTER_ENTRIES,
} from "../../src/installer/root-config.js";
import { makeProject, cleanProject } from "../fixtures/installer-fixture.mjs";

test("lock schema: v3 is the current revision and v1/v2 still validate", () => {
  assert.equal(CURRENT_LOCK_SCHEMA, 3, "Task 3 must promote CURRENT_LOCK_SCHEMA to 3");
  // v1 legacy manager-aware lock should still parse as legacy core.
  const v1 = {
    contractVersion: 1,
    manager: { schemaVersion: 1, name: "opencode-ship", version: "0.1.0", appliedAt: new Date().toISOString(), config: { path: ".opencode/ship.config.json", sha256: "a".repeat(64) } },
    files: [],
    integrity: { lockSha256: "b".repeat(64) },
  };
  v1.integrity.lockSha256 = computeIntegrity(v1).lockSha256;
  const v1Result = validateLock(v1);
  assert.equal(v1Result.ok, true, `v1 should still validate: ${v1Result.issues.join("; ")}`);

  // v2 core lock should still validate.
  const v2 = {
    contractVersion: 2,
    manager: {
      schemaVersion: 2,
      name: "opencode-ship",
      version: "0.9.0",
      profile: "core",
      appliedAt: new Date().toISOString(),
      config: { path: ".opencode/ship.config.json", sha256: "c".repeat(64) },
    },
    files: [],
    integrity: { lockSha256: "d".repeat(64) },
  };
  v2.integrity.lockSha256 = computeIntegrity(v2).lockSha256;
  const v2Result = validateLock(v2);
  assert.equal(v2Result.ok, true, `v2 should still validate: ${v2Result.issues.join("; ")}`);
});

test("lock v3: root pointer records carry a scope and previous value", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  const rootPath = resolve(repoRoot, "opencode.json");
  // Pre-existing root config with the same value as the installer
  // wants at the delivery_verify pointer, plus an unrelated
  // user-owned entry. The lock must record the existing value as
  // `previous` so uninstall can restore it.
  const existing = { agent: { build: { permission: { delivery_verify: "deny" } } }, username: "fixture" };
  await writeFile(rootPath, JSON.stringify(existing, null, 2) + "\n");
  const { runInit } = await import("../../src/installer/commands/init.js");
  const r = await runInit({
    json: true,
    rootPath: repoRoot,
    profile: "core",
  });
  assert.equal(r.exitCode, 0, JSON.stringify(r));
  const lock = await readLock(repoRoot);
  assert.equal(lock.manager.schemaVersion, 3);
  const records = (lock.manager?.rootDocuments ?? []).flatMap((d) => d.pointers ?? []);
  const deliveryVerify = records.find((entry) => entry.pointer === "/agent/build/permission/delivery_verify");
  assert.ok(deliveryVerify, "delivery_verify pointer must be recorded");
  assert.equal(deliveryVerify.scope, "core", "Build permission pointers are core-scoped");
  assert.deepEqual(deliveryVerify.previous, { existed: true, value: "deny" });
});

test("engineering -> core removes the Plan Mode block and restores core pointer values", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  const rootPath = resolve(repoRoot, "opencode.json");
  const original = { agent: { build: { permission: { delivery_verify: "deny" } } } };
  await writeFile(rootPath, JSON.stringify(original, null, 2) + "\n");
  const { runInit } = await import("../../src/installer/commands/init.js");
  // Install engineering first; the Plan Mode block lands. The
  // engineering profile requires explicit models, so we must
  // supply them or the fail-closed planner rejects the install.
  const eng = await runInit({
    json: true,
    rootPath: repoRoot,
    profile: "engineering",
    forceConfig: true,
    models: {
      planner: "fake/strong-planner",
      builder: "fake/cheap-builder",
      finalReviewer: "fake/strong-reviewer",
    },
  });
  assert.equal(eng.exitCode, 0, `engineering init: ${JSON.stringify(eng)}`);
  const afterEng = JSON.parse(readFileSync(rootPath, "utf8"));
  assert.ok(afterEng.agent?.plan?.permission, "Plan Mode block must be present after engineering init");
  // Now transition back to core; the Plan Mode block must be removed.
  const core = await runInit({
    json: true,
    rootPath: repoRoot,
    profile: "core",
  });
  assert.equal(core.exitCode, 0, `core init: ${JSON.stringify(core)}`);
  const afterCore = JSON.parse(readFileSync(rootPath, "utf8"));
  assert.equal(afterCore.agent?.plan, undefined, "Plan Mode block must be removed on downgrade to core");
  // The original delivery_verify value must be preserved.
  assert.equal(afterCore.agent.build.permission.delivery_verify, "deny");
});

test("uninstall restores the prior root pointer values byte-by-byte", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  const rootPath = resolve(repoRoot, "opencode.json");
  // Use values that match the installer's defaults so the init
  // does not refuse. The user-owned `username` field must survive
  // the round-trip byte-identical.
  const original = {
    $schema: "https://opencode.ai/config.json",
    username: "fixture-user",
    agent: {
      build: {
        permission: {
          delivery_verify: "deny",
          delivery_review: "deny",
        },
      },
    },
  };
  await writeFile(rootPath, JSON.stringify(original, null, 2) + "\n");
  const originalBytes = readFileSync(rootPath, "utf8");
  const { runInit } = await import("../../src/installer/commands/init.js");
  const { runUninstall } = await import("../../src/installer/commands/uninstall.js");
  const init = await runInit({
    json: true,
    rootPath: repoRoot,
    profile: "engineering",
    forceConfig: true,
    models: {
      planner: "fake/strong-planner",
      builder: "fake/cheap-builder",
      finalReviewer: "fake/strong-reviewer",
    },
  });
  assert.equal(init.exitCode, 0, JSON.stringify(init));
  // After init, some pointers moved; the rest of the doc is preserved.
  const unin = await runUninstall({ json: true, rootPath: repoRoot });
  assert.equal(unin.exitCode, 0, JSON.stringify(unin));
  // The user's preinstall bytes must be byte-identical to the
  // preinstall state.
  const restoredBytes = readFileSync(rootPath, "utf8");
  assert.equal(restoredBytes, originalBytes, "uninstall must restore the original root config bytes");
  assert.equal(existsSync(lockPath(repoRoot)), false, "uninstall must remove the lock");
});

test("lock deletion is transactional (lock file is removed inside the journal)", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  const { runInit } = await import("../../src/installer/commands/init.js");
  const { runUninstall } = await import("../../src/installer/commands/uninstall.js");
  await runInit({ json: true, rootPath: repoRoot, profile: "core" });
  // Simulate a crash mid-uninstall by leaving a leftover journal
  // and re-running uninstall; the journal must be recovered and
  // the lock must end up gone.
  const { mkdir: mkdirP, writeFile: writeF } = await import("node:fs/promises");
  const shipDir = resolve(repoRoot, ".git", "opencode-ship");
  await mkdirP(shipDir, { recursive: true });
  await writeF(resolve(shipDir, ".txn-crashy.journal"), JSON.stringify({
    repoRoot,
    txnId: "crashy",
    ledger: [],
  }));
  const unin = await runUninstall({ json: true, rootPath: repoRoot });
  assert.equal(unin.exitCode, 0, JSON.stringify(unin));
  assert.equal(existsSync(lockPath(repoRoot)), false);
});

test("transition matrix: core -> engineering -> core -> engineering -> uninstall ends at the preinstall state", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  const rootPath = resolve(repoRoot, "opencode.json");
  const original = {
    $schema: "https://opencode.ai/config.json",
    username: "fixture",
    agent: { build: { permission: { delivery_verify: "deny", delivery_review: "deny" } } },
  };
  await writeFile(rootPath, JSON.stringify(original, null, 2) + "\n");
  const originalBytes = readFileSync(rootPath, "utf8");
  const { runInit } = await import("../../src/installer/commands/init.js");
  const { runUninstall } = await import("../../src/installer/commands/uninstall.js");

  const profiles = ["core", "engineering", "core", "engineering"];
  for (const profile of profiles) {
    const r = await runInit({ json: true, rootPath: repoRoot, profile });
    assert.equal(r.exitCode, 0, `${profile} init: ${JSON.stringify(r)}`);
  }
  const unin = await runUninstall({ json: true, rootPath: repoRoot });
  assert.equal(unin.exitCode, 0, JSON.stringify(unin));
  const restoredBytes = readFileSync(rootPath, "utf8");
  assert.equal(restoredBytes, originalBytes, "the transition matrix must end at the preinstall bytes");
});

async function captureStdout(fn) {
  const chunks = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    return original(chunk, ...rest);
  };
  try {
    return { result: await fn(), output: chunks.join("") };
  } finally {
    process.stdout.write = original;
  }
}

test("profile transition fails closed when an installer pointer has been edited", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  const rootPath = resolve(repoRoot, "opencode.json");
  await writeFile(rootPath, JSON.stringify({ agent: { build: { permission: { delivery_verify: "deny" } } } }, null, 2) + "\n");
  const { runInit } = await import("../../src/installer/commands/init.js");
  const init = await captureStdout(() => runInit({
    json: true,
    rootPath: repoRoot,
    profile: "engineering",
    forceConfig: true,
    models: {
      planner: "fake/strong-planner",
      builder: "fake/cheap-builder",
      finalReviewer: "fake/strong-reviewer",
    },
  }));
  assert.equal(init.result.exitCode, 0, init.output);
  // Simulate the user editing the Plan Mode permission block after
  // install. The recorded `installedSha256` no longer matches the
  // current value, so the engineering -> core transition must
  // refuse to silently overwrite the user's edit.
  const userEdit = JSON.parse(readFileSync(rootPath, "utf8"));
  userEdit.agent.plan.permission.task = "allow";
  await writeFile(rootPath, JSON.stringify(userEdit, null, 2) + "\n");
  const core = await captureStdout(() => runInit({ json: true, rootPath: repoRoot, profile: "core" }));
  assert.notEqual(core.result.exitCode, 0, `expected drift refusal, got: ${core.output}`);
  assert.ok(/drift|conflict/i.test(core.output), `expected drift diagnostic, got: ${core.output}`);
});

test("uninstall fails closed when an installer pointer has been edited", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  const rootPath = resolve(repoRoot, "opencode.json");
  await writeFile(rootPath, JSON.stringify({ agent: { build: { permission: { delivery_verify: "deny" } } } }, null, 2) + "\n");
  const { runInit } = await import("../../src/installer/commands/init.js");
  const { runUninstall } = await import("../../src/installer/commands/uninstall.js");
  const init = await captureStdout(() => runInit({
    json: true,
    rootPath: repoRoot,
    profile: "engineering",
    forceConfig: true,
    models: {
      planner: "fake/strong-planner",
      builder: "fake/cheap-builder",
      finalReviewer: "fake/strong-reviewer",
    },
  }));
  assert.equal(init.result.exitCode, 0, init.output);
  // User edits the installer-owned pointer after install.
  const userEdit = JSON.parse(readFileSync(rootPath, "utf8"));
  userEdit.agent.build.permission.delivery_verify = "ask";
  await writeFile(rootPath, JSON.stringify(userEdit, null, 2) + "\n");
  const unin = await captureStdout(() => runUninstall({ json: true, rootPath: repoRoot }));
  assert.notEqual(unin.result.exitCode, 0, `expected drift refusal, got: ${unin.output}`);
  assert.ok(/drift|conflict/i.test(unin.output), `expected drift diagnostic, got: ${unin.output}`);
  // The lock must NOT have been removed; drift refusal must leave
  // the install intact so the user can recover manually.
  assert.equal(existsSync(lockPath(repoRoot)), true, "lock must survive a failed-closed uninstall");
});

test("uninstall with --purge-config transactionally removes ship.config.json", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  const { runInit } = await import("../../src/installer/commands/init.js");
  const { runUninstall } = await import("../../src/installer/commands/uninstall.js");
  const { existsSync: e } = await import("node:fs");
  const init = await runInit({ json: true, rootPath: repoRoot, profile: "core" });
  assert.equal(init.exitCode, 0, JSON.stringify(init));
  const cfgPath = resolve(repoRoot, ".opencode", "ship.config.json");
  assert.equal(e(cfgPath), true, "core init must write ship.config.json");
  const unin = await runUninstall({ json: true, rootPath: repoRoot, purgeConfig: true });
  assert.equal(unin.exitCode, 0, JSON.stringify(unin));
  assert.equal(e(cfgPath), false, "--purge-config must transactionally remove ship.config.json");
  assert.equal(e(lockPath(repoRoot)), false, "uninstall must also remove the lock");
});
