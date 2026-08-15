/*
 * Lock validation tests for opencode-ship.
 *
 * The installer is expected to refuse any lock whose schema is
 * unsupported and any lock whose integrity does not match. The
 * consumer-side test exercises the validator directly; the
 * installer-CLI tests assert the same surface through the doctor
 * and the `init`/`update` entry points.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateLock, CURRENT_LOCK_SCHEMA, lockSchemaRevision } from "../../src/installer/lock.js";
import { writeValidatedLock } from "../helpers/lock-validity.js";
import { bytesHashString } from "../../src/installer/hash.js";
import { stableStringify } from "../../src/installer/json-pointer.js";

function baseLock(extra = {}) {
  const base = {
    contractVersion: CURRENT_LOCK_SCHEMA,
    manager: {
      schemaVersion: CURRENT_LOCK_SCHEMA,
      name: "opencode-ship",
      version: "0.3.0",
      templateSet: "v0.3.0",
      appliedAt: new Date().toISOString(),
      config: { path: ".opencode/ship.config.json", sha256: "0".repeat(64), existed: false },
      rootDocuments: [],
    },
    files: [],
    cleanupPending: [],
    integrity: { lockSha256: "PLACEHOLDER" },
  };
  const out = { ...base, ...extra };
  if (extra.manager) out.manager = { ...base.manager, ...extra.manager };
  return out;
}

function sealIntegrity(lock) {
  const { integrity: _ignored, ...without } = lock;
  return { ...lock, integrity: { lockSha256: bytesHashString(stableStringify(without)) } };
}

test("CURRENT_LOCK_SCHEMA: declared and stable", () => {
  // Schema was bumped to 4 when setup-complete tracking moved
  // from the installer's runtime into the lock and the cleanup
  // retry state moved out into the Git common directory.
  // v1/v2/v3 locks still validate; see lock-profile.test.mjs
  // for the dedicated legacy assertions.
  assert.equal(CURRENT_LOCK_SCHEMA, 4);
  assert.equal(lockSchemaRevision(), 4);
});

test("validateLock: null lock is treated as a fresh install", () => {
  const r = validateLock(null);
  assert.equal(r.ok, true);
  assert.equal(r.kind, "missing");
});

test("validateLock: accepts a well-formed lock with sealed integrity", () => {
  const lock = sealIntegrity(baseLock());
  const r = validateLock(lock);
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.equal(r.kind, "ok");
});

test("validateLock: rejects an unsupported contractVersion with kind=schema", () => {
  const lock = sealIntegrity(baseLock({ contractVersion: 99 }));
  const r = validateLock(lock);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "schema");
});

test("validateLock: rejects an unsupported manager.schemaVersion with kind=schema", () => {
  const lock = sealIntegrity(baseLock({ manager: { schemaVersion: 99 } }));
  const r = validateLock(lock);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "schema");
});

test("validateLock: rejects an unknown manager.name with kind=shape", () => {
  const lock = sealIntegrity(baseLock({ manager: { name: "opencode-something-else" } }));
  const r = validateLock(lock);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "shape");
});

test("validateLock: rejects missing files array with kind=shape", () => {
  const lock = sealIntegrity(baseLock());
  delete lock.files;
  const recomputed = sealIntegrity(lock);
  const r = validateLock(recomputed);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "shape");
});

test("validateLock: detects integrity mismatch with kind=integrity", () => {
  const lock = baseLock();
  lock.integrity = { lockSha256: "deadbeef".repeat(8) };
  const r = validateLock(lock);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "integrity");
});

test("validateLock: rejects missing integrity section with kind=shape", () => {
  const lock = baseLock();
  delete lock.integrity;
  const r = validateLock(lock);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "shape");
});

test("validateLock: rejects a non-object root with kind=shape", () => {
  const r = validateLock([]);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "shape");
});

test("writeValidatedLock helper: persists schemaVersion overrides", async () => {
  const dir = await writeValidatedLock(sealIntegrity(baseLock()), { manager: { schemaVersion: 99 } });
  const file = readFileSync(`${dir}/ship.lock.json`, "utf8");
  assert.ok(file.includes("\"schemaVersion\": 99"));
});
