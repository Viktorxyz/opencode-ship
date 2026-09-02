/*
 * Plugin loading smoke test.
 *
 * Exercises the compiled bundle against the @opencode-ai/plugin
 * runtime types without booting OpenCode. It verifies:
 *   - the bundled plugin is the default-exported function
 *   - calling it returns an object with a `tool` key
 *   - the `tool` object exposes exactly the canonical named tool
 *     definitions (17 ship lifecycle + 17 delivery aliases + 17 workflow)
 *
 * The canonical tool set is imported from
 * `tests/plugin/expected-tools.mjs`, the single source of truth
 * shared with the opencode-discovery smoke test.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { EXPECTED_OPENCODE_SHIP_TOOL_IDS, OPENCODE_SHIP_TOOL_COUNT, LIFECYCLE_TOOL_ALIASES } from "./expected-tools.mjs";

const pluginPath = pathToFileURL(resolve("dist/plugin.js")).href;

const EXPECTED_TOOLS = EXPECTED_OPENCODE_SHIP_TOOL_IDS;

test("plugin: default export is a function", async () => {
  const mod = await import(pluginPath);
  assert.equal(typeof mod.default, "function");
  assert.equal(typeof mod.ShipPlugin, "function");
});

test("plugin: bundle exports only plugin entry functions", async () => {
  const mod = await import(pluginPath);
  assert.deepEqual(Object.keys(mod).sort(), ["ShipPlugin", "default"]);
});

test("plugin: registers the canonical tool set including delivery_* aliases", async () => {
  const mod = await import(pluginPath);
  const fakeCtx = {
    worktree: process.cwd(),
    project: { worktree: process.cwd() },
    client: {},
    directory: process.cwd(),
  };
  const result = await mod.default(fakeCtx);
  assert.ok(result.tool, "result.tool should exist");
  const ids = Object.keys(result.tool).sort();
  assert.deepEqual(ids, EXPECTED_TOOLS, `expected ${OPENCODE_SHIP_TOOL_COUNT} tools, got ${ids.length}: ${ids.join(", ")}`);
  for (const id of ids) {
    assert.equal(typeof result.tool[id].execute, "function", `${id} should expose an execute function`);
    assert.equal(typeof result.tool[id].description, "string", `${id} should expose a description`);
  }
});

test("plugin: every tool returns a contract-version-2 envelope", async () => {
  const mod = await import(pluginPath);
  const fakeCtx = {
    worktree: process.cwd(),
    project: { worktree: process.cwd() },
    client: {},
    directory: process.cwd(),
  };
  const result = await mod.default(fakeCtx);
  for (const id of Object.keys(result.tool)) {
    const raw = await result.tool[id].execute({}, fakeCtx);
    const parsed = JSON.parse(raw);
    assert.equal(parsed.contractVersion, 2, `${id} must return contract-version-2 envelope`);
    assert.ok(typeof parsed.kind === "string", `${id} must include a kind`);
  }
});

test("plugin: ship_issue and delivery_issue exist and share behavior", async () => {
  const mod = await import(pluginPath);
  const fakeCtx = {
    worktree: process.cwd(),
    project: { worktree: process.cwd() },
    client: {},
    directory: process.cwd(),
  };
  const result = await mod.default(fakeCtx);
  for (const [canonical, alias] of LIFECYCLE_TOOL_ALIASES) {
    assert.ok(result.tool[canonical], `missing canonical ${canonical}`);
    assert.ok(result.tool[alias], `missing alias ${alias}`);
    assert.equal(result.tool[canonical].description, result.tool[alias].description, `${canonical} and ${alias} must share description`);
    const canonicalEnv = JSON.parse(await result.tool[canonical].execute({}, fakeCtx));
    const aliasEnv = JSON.parse(await result.tool[alias].execute({}, fakeCtx));
    assert.equal(canonicalEnv.ok, aliasEnv.ok, `${canonical} and ${alias} must share ok`);
    const canonicalBody = canonicalEnv.data ?? canonicalEnv.details ?? canonicalEnv.message;
    const aliasBody = aliasEnv.data ?? aliasEnv.details ?? aliasEnv.message;
    assert.deepEqual(canonicalBody, aliasBody, `${canonical} and ${alias} must share payload`);
  }
});
