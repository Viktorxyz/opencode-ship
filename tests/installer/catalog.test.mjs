/*
 * Catalog contract tests for opencode-ship.
 *
 * The installer must treat `src/installer/catalog.js` as the single
 * source of truth for managed assets. New managed files are added
 * in one place: `CATALOG`. These tests guard that contract so
 * `init`, `diff`, `update`, `doctor`, and the planner/executor
 * transaction layers see a coherent view.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { resolve } from "node:path";

import { CATALOG, validateCatalog, PACKAGE_VERSION } from "../../src/installer/catalog.js";
import { TEMPLATE_SET } from "../../src/version.js";

test("CATALOG: every entry declares id, kind, path, source, and mode", () => {
  for (const entry of CATALOG) {
    assert.equal(typeof entry.id, "string");
    assert.ok(entry.id.length > 0, `empty id: ${JSON.stringify(entry)}`);
    assert.ok(["plugin", "agent", "skill", "support"].includes(entry.kind));
    assert.ok(entry.path.startsWith(".opencode/"), `path not rooted under .opencode/: ${entry.path}`);
    assert.equal(entry.path.startsWith(".opencode/plugin/"), false, `legacy singular plugin path: ${entry.path}`);
    assert.equal(typeof entry.source, "string");
    assert.ok(entry.source.length > 0);
    assert.equal(entry.mode, 0o644);
  }
});

test("CATALOG: ids are unique across the catalog", () => {
  const seen = new Set();
  for (const entry of CATALOG) {
    assert.ok(!seen.has(entry.id), `duplicate catalog id: ${entry.id}`);
    seen.add(entry.id);
  }
});

test("CATALOG: paths are unique across the catalog", () => {
  const seen = new Set();
  for (const entry of CATALOG) {
    assert.ok(!seen.has(entry.path), `duplicate catalog path: ${entry.path}`);
    seen.add(entry.path);
  }
});

test("CATALOG: every source file exists, is a regular file, and is non-empty", () => {
  for (const entry of CATALOG) {
    const stats = statSync(entry.source);
    assert.ok(stats.isFile(), `${entry.id} -> not a regular file: ${entry.source}`);
    assert.ok(stats.size > 0, `${entry.id} -> empty file: ${entry.source}`);
  }
});

test("CATALOG: version constants agree with package.json", async () => {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(resolve("package.json"), "utf8");
  const pkg = JSON.parse(raw);
  assert.equal(PACKAGE_VERSION, pkg.version);
  assert.equal(TEMPLATE_SET, `v${pkg.version}`);
});

test("validateCatalog: passes for the real catalog", () => {
  const validated = validateCatalog();
  assert.equal(validated, CATALOG);
});

test("validateCatalog: rejects an entry with an empty source", () => {
  const broken = [{ ...CATALOG[0], source: "" }];
  assert.throws(() => validateCatalog({ catalog: broken }), /catalog validation failed/);
});

test("validateCatalog: rejects a duplicate id", () => {
  const broken = [...CATALOG, { ...CATALOG[0] }];
  assert.throws(() => validateCatalog({ catalog: broken }), /duplicate catalog id/);
});

test("validateCatalog: rejects a path outside .opencode/", () => {
  const broken = [{ ...CATALOG[0], path: "../../escape.md" }];
  assert.throws(() => validateCatalog({ catalog: broken }), /path must be rooted under/);
});

test("validateCatalog: rejects an unknown kind", () => {
  const broken = [{ ...CATALOG[0], kind: "wonderkind" }];
  assert.throws(() => validateCatalog({ catalog: broken }), /unsupported entry kind/);
});

test("CATALOG: canonical ship agent and skill ids exist", () => {
  const ids = new Set(CATALOG.map((e) => e.id));
  assert.ok(ids.has("agent:ship-reviewer"));
  assert.ok(ids.has("agent:ship-verifier"));
  assert.ok(ids.has("skill:ship-workflow"));
  const reviewer = CATALOG.find((e) => e.id === "agent:ship-reviewer");
  const verifier = CATALOG.find((e) => e.id === "agent:ship-verifier");
  const workflow = CATALOG.find((e) => e.id === "skill:ship-workflow");
  assert.equal(reviewer.path, ".opencode/agents/ship-reviewer.md");
  assert.equal(verifier.path, ".opencode/agents/ship-verifier.md");
  assert.equal(workflow.path, ".opencode/skills/ship-workflow/SKILL.md");
});

test("CATALOG: legacy delivery entries are adopt-on-match aliases", () => {
  const legacyReviewer = CATALOG.find((e) => e.id === "agent:delivery-reviewer");
  const shipReviewer = CATALOG.find((e) => e.id === "agent:ship-reviewer");
  const legacyVerifier = CATALOG.find((e) => e.id === "agent:delivery-verifier");
  const shipVerifier = CATALOG.find((e) => e.id === "agent:ship-verifier");
  const legacyWorkflow = CATALOG.find((e) => e.id === "skill:delivery-workflow");
  const shipWorkflow = CATALOG.find((e) => e.id === "skill:ship-workflow");
  assert.equal(legacyReviewer.legacy, true);
  assert.equal(legacyVerifier.legacy, true);
  assert.equal(legacyWorkflow.legacy, true);
  assert.equal(legacyReviewer.source, shipReviewer.source);
  assert.equal(legacyVerifier.source, shipVerifier.source);
  assert.equal(legacyWorkflow.source, shipWorkflow.source);
  assert.equal(legacyReviewer.path, ".opencode/agents/delivery-reviewer.md");
  assert.equal(legacyVerifier.path, ".opencode/agents/delivery-verifier.md");
  assert.equal(legacyWorkflow.path, ".opencode/skills/delivery-workflow/SKILL.md");
});

test("validateCatalog: rejected error carries structured issues", () => {
  const broken = [{ ...CATALOG[0], kind: "wonderkind" }];
  try {
    validateCatalog({ catalog: broken });
    assert.fail("expected validateCatalog to throw");
  } catch (e) {
    assert.equal(e.catalogValidation, true);
    assert.ok(Array.isArray(e.issues));
    assert.equal(e.issues[0].kind, "kind");
  }
});
