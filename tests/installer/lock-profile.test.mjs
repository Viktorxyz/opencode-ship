/*
 * Unit tests for src/installer/lock.js.
 *
 * Verifies the lock schema v4 contract:
 *   - manager.profile is REQUIRED on newly written locks and
 *     validated to be one of PROFILES (engineering) or the legacy
 *     core (read-compat only).
 *   - v1/v2/v3 locks still validate so existing consumers can
 *     upgrade.
 *   - normalizeLegacyLock strips cleanupPending so v4 writes don't
 *     carry runtime state.
 *   - integrity is computed over all lock fields except integrity.
 *   - DEFAULT_PROFILE is engineering.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  CURRENT_LOCK_SCHEMA,
  validateLock,
  computeIntegrity,
  lockSchemaRevision,
  normalizeLegacyLock,
} from "../../src/installer/lock.js";
import { DEFAULT_PROFILE } from "../../src/profile.js";

test("CURRENT_LOCK_SCHEMA: v4 after setup-complete contract", () => {
  assert.equal(typeof CURRENT_LOCK_SCHEMA, "number");
  assert.ok(CURRENT_LOCK_SCHEMA >= 4, `expected schema >= 4, got ${CURRENT_LOCK_SCHEMA}`);
  assert.equal(lockSchemaRevision(), CURRENT_LOCK_SCHEMA);
});

test("validateLock: accepts a v0.3 lock without profile as legacy default", () => {
  const legacy = {
    contractVersion: 1,
    manager: { schemaVersion: 1, name: "opencode-ship", version: "0.3.0" },
    files: [],
    integrity: { lockSha256: "ignored-by-helper" },
  };
  legacy.integrity = computeIntegrity(legacy);
  const r = validateLock(legacy);
  assert.equal(r.ok, true, `expected ok, got ${JSON.stringify(r)}`);
  assert.equal(r.kind, "ok");
});

test("validateLock: v3 lock with profile=core is accepted for read-compat", () => {
  const lock = {
    contractVersion: 3,
    manager: {
      schemaVersion: 3,
      name: "opencode-ship",
      version: "1.0.0",
      profile: "core",
    },
    files: [],
  };
  lock.integrity = computeIntegrity(lock);
  const r = validateLock(lock);
  assert.equal(r.ok, true);
  assert.equal(r.kind, "ok");
});

test("validateLock: profile=engineering locks validate as ok", () => {
  const lock = {
    contractVersion: CURRENT_LOCK_SCHEMA,
    manager: {
      schemaVersion: CURRENT_LOCK_SCHEMA,
      name: "opencode-ship",
      version: "1.1.1",
      profile: "engineering",
    },
    files: [],
  };
  lock.integrity = computeIntegrity(lock);
  const r = validateLock(lock);
  assert.equal(r.ok, true);
  assert.equal(r.kind, "ok");
});

test("validateLock: unknown profiles still fail closed", () => {
  const lock = {
    contractVersion: CURRENT_LOCK_SCHEMA,
    manager: {
      schemaVersion: CURRENT_LOCK_SCHEMA,
      name: "opencode-ship",
      version: "1.1.1",
      profile: "practices",
    },
    files: [],
  };
  lock.integrity = computeIntegrity(lock);
  const r = validateLock(lock);
  assert.equal(r.ok, false);
  assert.match(r.issues.join(" "), /invalid manager.profile/);
});

test("validateLock: integrity mismatch is reported", () => {
  const lock = {
    contractVersion: CURRENT_LOCK_SCHEMA,
    manager: {
      schemaVersion: CURRENT_LOCK_SCHEMA,
      name: "opencode-ship",
      version: "1.1.1",
      profile: "engineering",
    },
    files: [],
    integrity: { lockSha256: "0".repeat(64) },
  };
  const r = validateLock(lock);
  assert.equal(r.ok, false);
  assert.equal(r.kind, "integrity");
});

test("computeIntegrity: stable across profile additions", () => {
  const base = {
    contractVersion: CURRENT_LOCK_SCHEMA,
    manager: {
      schemaVersion: CURRENT_LOCK_SCHEMA,
      name: "opencode-ship",
      version: "1.1.1",
      profile: "engineering",
    },
    files: [],
  };
  const h1 = computeIntegrity(base).lockSha256;
  const h2 = computeIntegrity({ ...base, manager: { ...base.manager, setupComplete: true } }).lockSha256;
  assert.notEqual(h1, h2, "integrity must change when setupComplete changes");
});

test("normalizeLegacyLock: strips cleanupPending from pre-v4 locks", () => {
  const legacy = {
    contractVersion: 3,
    manager: { schemaVersion: 3, name: "opencode-ship", profile: "engineering" },
    files: [],
    cleanupPending: [{ taskId: "abc", stage: "branch-delete" }],
  };
  const normalized = normalizeLegacyLock(legacy);
  assert.equal(normalized.cleanupPending, undefined);
  assert.equal(normalized.contractVersion, 3);
});

test("DEFAULT_PROFILE: is engineering", () => {
  assert.equal(DEFAULT_PROFILE, "engineering");
});
