/*
 * Unit tests for src/profile.js resolveProfile.
 *
 * Verifies the engineering-only contract with legacy-core
 * migration on the read path:
 *   - PROFILES contains only "engineering" (since 1.1.0).
 *   - DEFAULT_PROFILE is "engineering".
 *   - New CLI/config input of "core" is rejected.
 *   - Persisted legacy "core" values (lock/config) promote to
 *     "engineering" with `promotedFrom: "core"`.
 *   - Invalid profiles throw a descriptive error.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { resolveProfile, PROFILES, DEFAULT_PROFILE, isValidProfile, isLegacyProfile, LEGACY_PROFILES } from "../../src/profile.js";

test("PROFILES: exactly engineering", () => {
  assert.deepEqual([...PROFILES], ["engineering"]);
  assert.equal(DEFAULT_PROFILE, "engineering");
});

test("LEGACY_PROFILES: contains core for read-path migration", () => {
  assert.deepEqual([...LEGACY_PROFILES], ["core"]);
  assert.ok(isLegacyProfile("core"));
  assert.ok(!isLegacyProfile("engineering"));
});

test("isValidProfile: only accepts the active profile set", () => {
  assert.equal(isValidProfile("engineering"), true);
  assert.equal(isValidProfile("core"), false);
  assert.equal(isValidProfile("practices"), false);
  assert.equal(isValidProfile(""), false);
  assert.equal(isValidProfile(null), false);
  assert.equal(isValidProfile(undefined), false);
  assert.equal(isValidProfile(42), false);
});

test("resolveProfile: defaults to engineering when all sources are empty", () => {
  const r = resolveProfile({});
  assert.equal(r.profile, "engineering");
  assert.equal(r.source, "default");
  assert.equal(r.promotedFrom, undefined);
});

test("resolveProfile: CLI > config > lock > default", () => {
  // CLI wins over everything
  const r1 = resolveProfile({
    cli: "engineering",
    config: { profile: "engineering" },
    lock: { manager: { profile: "engineering" } },
  });
  assert.equal(r1.profile, "engineering");
  assert.equal(r1.source, "cli");

  // Config wins over lock and default
  const r2 = resolveProfile({
    config: { profile: "engineering" },
    lock: { manager: { profile: "engineering" } },
  });
  assert.equal(r2.profile, "engineering");
  assert.equal(r2.source, "config");

  // Lock wins over default
  const r3 = resolveProfile({
    lock: { manager: { profile: "engineering" } },
  });
  assert.equal(r3.profile, "engineering");
  assert.equal(r3.source, "lock");
});

test("resolveProfile: legacy v0.3 lock (no profile field) falls through to default", () => {
  const r = resolveProfile({ lock: { manager: { schemaVersion: 1, name: "opencode-ship" } } });
  assert.equal(r.profile, "engineering");
  assert.equal(r.source, "default");
});

test("resolveProfile: persisted legacy 'core' in config promotes to engineering", () => {
  const r = resolveProfile({ config: { profile: "core" } });
  assert.equal(r.profile, "engineering");
  assert.equal(r.source, "default");
  assert.equal(r.promotedFrom, "core");
});

test("resolveProfile: persisted legacy 'core' in lock promotes to engineering", () => {
  const r = resolveProfile({ lock: { manager: { profile: "core" } } });
  assert.equal(r.profile, "engineering");
  assert.equal(r.source, "default");
  assert.equal(r.promotedFrom, "core");
});

test("resolveProfile: CLI input of 'core' is rejected (core removed in 1.1.0)", () => {
  assert.throws(
    () => resolveProfile({ cli: "core" }),
    /unknown CLI profile 'core'/,
  );
});

test("resolveProfile: unknown CLI profile throws", () => {
  assert.throws(
    () => resolveProfile({ cli: "practices" }),
    /unknown CLI profile 'practices'/,
  );
});

test("resolveProfile: invalid config profile throws", () => {
  assert.throws(
    () => resolveProfile({ config: { profile: "practices" } }),
    /unknown ship\.config\.json profile 'practices'/,
  );
});

test("resolveProfile: invalid lock manager.profile throws", () => {
  assert.throws(
    () => resolveProfile({ lock: { manager: { profile: "practices" } } }),
    /unknown lock manager\.profile 'practices'/,
  );
});

test("resolveProfile: legacy 'core' in lock + fresh CLI 'engineering' keeps CLI choice", () => {
  const r = resolveProfile({
    cli: "engineering",
    lock: { manager: { profile: "core" } },
  });
  assert.equal(r.profile, "engineering");
  assert.equal(r.source, "cli");
  assert.equal(r.promotedFrom, undefined);
});

test("resolveProfile: legacy 'core' in config promotes to engineering with default source", () => {
  // Config precedence wins over lock; a persisted legacy config
  // is promoted to engineering and surfaced as "default" because
  // the user's literal value was "core". The lock is consulted
  // next only when config has no profile.
  const r = resolveProfile({
    config: { profile: "core" },
    lock: { manager: { profile: "engineering" } },
  });
  assert.equal(r.profile, "engineering");
  assert.equal(r.source, "default");
  assert.equal(r.promotedFrom, "core");
});
