/*
 * Unit tests for catalog profile filtering.
 *
 * From 1.1.0 the catalog only declares the engineering profile.
 * filterCatalogByProfile still accepts the legacy "core" read key
 * so persisted config/lock files load; the resulting catalog is
 * the engineering superset. New CLI selection of "core" fails.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { CATALOG, filterCatalogByProfile, validateCatalog } from "../../src/installer/catalog.js";
import { PROFILES } from "../../src/profile.js";

test("CATALOG: every entry declares a profiles array", () => {
  for (const e of CATALOG) {
    assert.ok(Array.isArray(e.profiles), `entry ${e.id} missing profiles array`);
    assert.ok(e.profiles.length > 0, `entry ${e.id} has empty profiles array`);
    for (const p of e.profiles) {
      assert.ok(PROFILES.includes(p), `entry ${e.id} references unknown profile '${p}'`);
    }
  }
});

test("CATALOG: validateCatalog accepts entries with profiles", () => {
  assert.doesNotThrow(() => validateCatalog());
});

test("filterCatalogByProfile: engineering returns all entries", () => {
  const eng = filterCatalogByProfile(CATALOG, "engineering");
  assert.equal(eng.length, CATALOG.length);
  for (const e of eng) {
    assert.ok(e.profiles.includes("engineering"), `entry ${e.id} not in engineering but returned`);
  }
});

test("filterCatalogByProfile: legacy 'core' returns the engineering superset (read-compat)", () => {
  // Persisted config/lock files may still say "core"; the
  // read path maps that to engineering so existing consumers
  // converge safely.
  const fromCore = filterCatalogByProfile(CATALOG, "core");
  const eng = filterCatalogByProfile(CATALOG, "engineering");
  assert.deepEqual(fromCore, eng);
});

test("filterCatalogByProfile: rejects unknown profile", () => {
  assert.throws(() => filterCatalogByProfile(CATALOG, "practices"), /profile/i);
});

test("filterCatalogByProfile: default profile is engineering", () => {
  const a = filterCatalogByProfile(CATALOG, "engineering");
  const b = filterCatalogByProfile(CATALOG, undefined);
  assert.deepEqual(a, b);
});
