/*
 * Unit tests for src/profile.js resolveProfile.
 *
 * Verifies the documented precedence: CLI > ship.config > lock > core.
 * Invalid profiles must throw a descriptive Error.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { resolveProfile, PROFILES, DEFAULT_PROFILE, isValidProfile } from "../../src/profile.js";

test("PROFILES: exactly core and engineering, in that order", () => {
  assert.deepEqual([...PROFILES], ["core", "engineering"]);
  assert.equal(DEFAULT_PROFILE, "core");
});

test("isValidProfile: only accepts the known profiles", () => {
  assert.equal(isValidProfile("core"), true);
  assert.equal(isValidProfile("engineering"), true);
  assert.equal(isValidProfile("practices"), false);
  assert.equal(isValidProfile(""), false);
  assert.equal(isValidProfile(null), false);
  assert.equal(isValidProfile(undefined), false);
  assert.equal(isValidProfile(42), false);
});

test("resolveProfile: defaults to core when all sources are empty", () => {
  const r = resolveProfile({});
  assert.equal(r.profile, "core");
  assert.equal(r.source, "default");
});

test("resolveProfile: CLI > config > lock > default", () => {
  // CLI wins over everything
  const r1 = resolveProfile({
    cli: "engineering",
    config: { profile: "core" },
    lock: { manager: { profile: "engineering" } },
  });
  assert.equal(r1.profile, "engineering");
  assert.equal(r1.source, "cli");

  // Config wins over lock and default
  const r2 = resolveProfile({
    config: { profile: "core" },
    lock: { manager: { profile: "engineering" } },
  });
  assert.equal(r2.profile, "core");
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
  assert.equal(r.profile, "core");
  assert.equal(r.source, "default");
});

test("resolveProfile: undefined/null config.profile is treated as absent", () => {
  const r1 = resolveProfile({ config: { profile: undefined } });
  assert.equal(r1.profile, "core");
  assert.equal(r1.source, "default");
  const r2 = resolveProfile({ config: { profile: null } });
  assert.equal(r2.profile, "core");
  assert.equal(r2.source, "default");
});

test("resolveProfile: invalid CLI profile throws", () => {
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
