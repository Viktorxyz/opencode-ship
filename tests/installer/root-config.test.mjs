/*
 * Installer root-config and uninstall-pointer tests for opencode-ship.
 *
 * These tests guard the contract that:
 *   - `init` records every installer-owned pointer, including
 *     equal-existing ones, so future `uninstall` can restore;
 *   - root-config writes go through the transaction layer so a
 *     failing write does not desync the lock;
 *   - the engineering profile injects the Plan Mode permission
 *     block under `agent.plan.permission` so consumers can spin up
 *     a Plan Mode sub-agent without hand-editing opencode.json.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";

import { previewUninstall } from "../../src/installer/executor.js";
import { runInit } from "../../src/installer/commands/init.js";
import { makeProject, cleanProject } from "../fixtures/installer-fixture.mjs";

async function initIntoProject(repoRoot) {
  const result = await runInit({ json: false, rootPath: repoRoot, forceRootConfig: false, forceConfig: false, strictDoctor: false });
  return result;
}

test("root-config plan: init records every installer-owned pointer", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));

  await initIntoProject(repoRoot);
  const locked = JSON.parse(readFileSync(resolve(repoRoot, ".opencode/ship.lock.json"), "utf8"));
  const rootDocuments = locked.manager?.rootDocuments ?? [];
  const records = rootDocuments.flatMap((d) => d.pointers ?? []);
  assert.ok(records.length > 0, "root pointers must be recorded after init");
  const pointers = new Set(records.map((r) => r.pointer));
  for (const expected of [
    "/agent/build/permission/delivery_verify",
    "/agent/build/permission/delivery_review",
    "/agent/build/permission/delivery_merge",
    "/agent/build/permission/task/delivery-reviewer",
    "/agent/build/permission/task/delivery-verifier",
  ]) {
    assert.ok(pointers.has(expected), `missing pointer record: ${expected}`);
  }
});

test("root-config plan: lock remains integrity-clean after fresh install", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  await initIntoProject(repoRoot);
  const locked = JSON.parse(readFileSync(resolve(repoRoot, ".opencode/ship.lock.json"), "utf8"));
  assert.equal(typeof locked.integrity?.lockSha256, "string");
  assert.match(locked.integrity.lockSha256, /^[0-9a-f]{64}$/);
});

test("uninstall: refuses to remove a modified managed file", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));

  await initIntoProject(repoRoot);
  const pluginPath = resolve(repoRoot, ".opencode/plugins/opencode-ship.js");
  await appendFile(pluginPath, "\n// local modification\n");

  const preview = await previewUninstall({ rootPath: repoRoot });
  assert.equal(preview.ok, true);
  assert.equal(preview.conflicts.length, 1);
  assert.equal(preview.conflicts[0].relPath, ".opencode/plugins/opencode-ship.js");
  assert.match(preview.conflicts[0].reason, /locally modified/);
});

test("applyPlanModeOwnership: injects the Plan Mode block under agent.plan.permission", async () => {
  const { applyPlanModeOwnership, planModeBlock } = await import("../../src/installer/root-config.js");
  const doc = {};
  const result = applyPlanModeOwnership(doc);
  assert.deepEqual(result.doc.agent?.plan?.permission, planModeBlock());
  // The block is the deny-first shape from plan-mode-permissions.js.
  assert.equal(result.doc.agent.plan.permission.bash, "deny");
  assert.equal(result.doc.agent.plan.permission.edit["*"], "deny");
  assert.equal(
    result.doc.agent.plan.permission.edit[".git/opencode-ship/plans/**"],
    "allow",
  );
  assert.equal(result.doc.agent.plan.permission.task, "deny");
  assert.equal(result.doc.agent.plan.permission.write, undefined);
});

test("applyPlanModeOwnership: previous value is captured for uninstall restoration", async () => {
  const { applyPlanModeOwnership } = await import("../../src/installer/root-config.js");
  // Simulate a consumer who already configured a Plan Mode
  // permission (different from what we install). The previous
  // value must be returned so uninstall can restore it.
  const existing = { bash: "ask", edit: { "**/*": "allow" } };
  const doc = { agent: { plan: { permission: existing } } };
  const result = applyPlanModeOwnership(doc);
  assert.deepEqual(result.previous, existing);
  assert.equal(result.doc.agent.plan.permission.bash, "deny");
});

test("applyPlanModeOwnership: id is stable for the run ledger", async () => {
  const { applyPlanModeOwnership } = await import("../../src/installer/root-config.js");
  const a = applyPlanModeOwnership({});
  const b = applyPlanModeOwnership({});
  assert.equal(a.id, b.id);
  assert.equal(a.id, "/agent/plan/permission");
});

test("end-to-end: init --profile engineering writes the Plan Mode block into the consumer's opencode.json", async (t) => {
  const { runInit } = await import("../../src/installer/commands/init.js");
  const { readFileSync, existsSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const { makeProject, cleanProject } = await import("../fixtures/installer-fixture.mjs");
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  // Init with engineering profile; force the root config so the
  // Plan Mode block has somewhere to land. The engineering profile
  // requires explicit models; provide three of them so the
  // fail-closed planner does not reject the install.
  const r = await runInit({
    json: true,
    rootPath: repoRoot,
    profile: "engineering",
    forceRootConfig: true,
    forceConfig: true,
    models: {
      planner: "fake/strong-planner",
      builder: "fake/cheap-builder",
      finalReviewer: "fake/strong-reviewer",
    },
  });
  assert.equal(r.exitCode, 0, r.stderr || r.stdout);
  // The consumer must have opencode.json after forceRootConfig.
  const rootPath = resolve(repoRoot, "opencode.json");
  assert.ok(existsSync(rootPath), "opencode.json should exist after forceRootConfig");
  const doc = JSON.parse(readFileSync(rootPath, "utf8"));
  assert.ok(doc.agent?.plan?.permission, "Plan Mode block must be injected under agent.plan.permission");
  assert.equal(doc.agent.plan.permission.bash, "deny");
  assert.equal(doc.agent.plan.permission.edit["*"], "deny");
  assert.equal(
    doc.agent.plan.permission.edit[".git/opencode-ship/plans/**"],
    "allow",
  );
});

test("end-to-end: engineering init adds Plan Mode permissions to an existing root config", async (t) => {
  const { runInit } = await import("../../src/installer/commands/init.js");
  const { readFile, writeFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const { makeProject, cleanProject } = await import("../fixtures/installer-fixture.mjs");
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  const rootPath = resolve(repoRoot, "opencode.json");
  await writeFile(rootPath, JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    username: "fixture-user",
  }, null, 2) + "\n");

  const r = await runInit({
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
  assert.equal(r.exitCode, 0, r.stderr || r.stdout);

  const doc = JSON.parse(await readFile(rootPath, "utf8"));
  assert.equal(doc.username, "fixture-user");
  assert.equal(doc.agent.plan.permission.edit["*"], "deny");
  assert.equal(doc.agent.plan.permission.edit[".git/opencode-ship/plans/**"], "allow");

  const lock = JSON.parse(await readFile(resolve(repoRoot, ".opencode/ship.lock.json"), "utf8"));
  const records = (lock.manager?.rootDocuments ?? []).flatMap((entry) => entry.pointers ?? []);
  assert.ok(records.some((entry) => entry.pointer === "/agent/plan/permission"));
});

test("end-to-end: engineering init does not overwrite existing Plan Mode permissions", async (t) => {
  const { runInit } = await import("../../src/installer/commands/init.js");
  const { readFile, writeFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const { makeProject, cleanProject } = await import("../fixtures/installer-fixture.mjs");
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  const rootPath = resolve(repoRoot, "opencode.json");
  const existing = { bash: "ask", edit: { "docs/plans/**": "allow" } };
  await writeFile(rootPath, JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    agent: { plan: { permission: existing } },
  }, null, 2) + "\n");

  const r = await runInit({
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
  assert.equal(r.exitCode, 3, r.stderr || r.stdout);

  const doc = JSON.parse(await readFile(rootPath, "utf8"));
  assert.deepEqual(doc.agent.plan.permission, existing);
});

test("end-to-end: init --profile core is rejected (core removed in 1.1.0)", async (t) => {
  const { runInit } = await import("../../src/installer/commands/init.js");
  const { makeProject, cleanProject } = await import("../fixtures/installer-fixture.mjs");
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  const r = await runInit({
    json: true,
    rootPath: repoRoot,
    profile: "core",
    forceRootConfig: true,
  });
  // core was removed in 1.1.0; init should fail with exit 2
  assert.equal(r.exitCode, 2, r.stderr || r.stdout);
});
