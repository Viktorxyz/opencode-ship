/*
 * Unit tests for catalog profile filtering.
 *
 * The catalog declares which profile(s) each entry belongs to.
 * init/update must only install entries whose profile list
 * includes the active profile. The "core" profile is the
 * baseline; "engineering" extends it.
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

test("filterCatalogByProfile: core returns all entries that are core (or both)", () => {
  const core = filterCatalogByProfile(CATALOG, "core");
  // Every entry must include "core" in its profiles list
  for (const e of core) {
    assert.ok(e.profiles.includes("core"), `entry ${e.id} not in core but returned for core`);
  }
});

test("filterCatalogByProfile: engineering returns entries marked engineering (or both)", () => {
  const eng = filterCatalogByProfile(CATALOG, "engineering");
  for (const e of eng) {
    assert.ok(e.profiles.includes("engineering"), `entry ${e.id} not in engineering but returned for engineering`);
  }
});

test("filterCatalogByProfile: engineering is a superset of core (or equal)", () => {
  const coreIds = new Set(filterCatalogByProfile(CATALOG, "core").map((e) => e.id));
  const engIds = new Set(filterCatalogByProfile(CATALOG, "engineering").map((e) => e.id));
  for (const id of coreIds) {
    assert.ok(engIds.has(id), `entry ${id} in core but missing from engineering`);
  }
});

test("filterCatalogByProfile: rejects unknown profile", () => {
  assert.throws(() => filterCatalogByProfile(CATALOG, "practices"), /profile/i);
});

test("filterCatalogByProfile: default profile is core", () => {
  const a = filterCatalogByProfile(CATALOG, "core");
  const b = filterCatalogByProfile(CATALOG, undefined);
  assert.deepEqual(a, b);
});
