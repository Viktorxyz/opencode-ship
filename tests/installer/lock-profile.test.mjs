/*
 * Unit tests for src/installer/lock.js.
 *
 * Verifies the lock schema version 2 carries a `manager.profile`
 * field and that v0.3 schema-1 locks without a profile load as
 * legacy core. Mirrors the docs in src/installer/lock.js.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  CURRENT_LOCK_SCHEMA,
  validateLock,
  computeIntegrity,
  lockSchemaRevision,
} from "../../src/installer/lock.js";
import { DEFAULT_PROFILE } from "../../src/profile.js";

test("CURRENT_LOCK_SCHEMA: bump to 2 once profile is required on new locks", () => {
  // The schema version is bumped when the lock shape changes. Slice 1
  // (CLI flag) and slice 2 (lock profile) together require this bump.
  assert.equal(typeof CURRENT_LOCK_SCHEMA, "number");
  assert.ok(CURRENT_LOCK_SCHEMA >= 2, `expected schema >= 2, got ${CURRENT_LOCK_SCHEMA}`);
  assert.equal(lockSchemaRevision(), CURRENT_LOCK_SCHEMA);
});

test("validateLock: accepts a v0.3 lock without profile as legacy core", () => {
  // v0.3 locks are manager-aware schema-1 but do not carry a
  // profile. They must still validate so the migration path can
  // load them; resolution of the missing profile happens in the
  // profile precedence logic (sibling slice).
  const legacy = {
    contractVersion: 1,
    manager: { schemaVersion: 1, name: "opencode-ship", version: "0.3.0" },
    files: [],
    integrity: { lockSha256: "ignored-by-helper" },
  };
  // Make integrity correct so validation passes
  legacy.integrity = computeIntegrity(legacy);
  const r = validateLock(legacy);
  assert.equal(r.ok, true, `expected ok, got ${JSON.stringify(r)}`);
  assert.equal(r.kind, "ok");
});

test("computeIntegrity: stable across profile additions", () => {
  // Adding manager.profile must not break integrity (the field
  // is included in the hash, so the hash changes; this test pins
  // that the schema correctly hashes the new field).
  const base = {
    contractVersion: CURRENT_LOCK_SCHEMA,
    manager: {
      schemaVersion: CURRENT_LOCK_SCHEMA,
      name: "opencode-ship",
      version: "0.4.0",
      profile: "core",
    },
    files: [],
  };
  const h1 = computeIntegrity(base).lockSha256;
  const h2 = computeIntegrity({ ...base, manager: { ...base.manager, profile: "engineering" } })
    .lockSha256;
  assert.notEqual(h1, h2, "integrity must change when profile changes");
});

test("validateLock: profile=core locks validate as ok", () => {
  const lock = {
    contractVersion: CURRENT_LOCK_SCHEMA,
    manager: {
      schemaVersion: CURRENT_LOCK_SCHEMA,
      name: "opencode-ship",
      version: "0.4.0",
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
      version: "0.4.0",
      profile: "engineering",
    },
    files: [],
  };
  lock.integrity = computeIntegrity(lock);
  const r = validateLock(lock);
  assert.equal(r.ok, true);
});

test("DEFAULT_PROFILE: is core", () => {
  assert.equal(DEFAULT_PROFILE, "core");
});
