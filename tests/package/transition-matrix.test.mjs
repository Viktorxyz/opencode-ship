/*
 * Engineering profile transition matrix smoke (lite).
 *
 * From 1.1.0 the only shipped profile is engineering. This module
 * verifies the engineering catalog installs the right set of files
 * and the lock carries the correct profile and setupComplete flag.
 *
 * Gated by `OPENCODE_SHIP_SMOKE_FULL=1`; the lite version always
 * runs and asserts only the local-dev file set.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { makeProject, cleanProject } from "../fixtures/installer-fixture.mjs";

const CLI = resolve("dist/cli.js");

function cli(repoRoot, args) {
  const r = spawnSync("node", [CLI, ...args, "--root", repoRoot], { encoding: "utf8" });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

test("transition matrix: --profile core is rejected (core removed in 1.1.0)", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  const r = cli(repoRoot, ["init", "--profile", "core", "--json"]);
  assert.equal(r.code, 2, JSON.stringify(r, null, 2));
  assert.match(r.stderr, /core/);
  assert.match(r.stderr, /removed/i);
});

test("transition matrix: engineering init installs engineering-only files", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  const r = cli(repoRoot, [
    "init", "--profile", "engineering", "--json",
    "--planner-model", "fake/strong-planner",
    "--builder-model", "fake/cheap-builder",
    "--final-reviewer-model", "fake/strong-reviewer",
    "--force-config",
  ]);
  assert.equal(r.code, 0, r.stderr);
  for (const f of [
    ".opencode/skills/triage/SKILL.md",
    ".opencode/skills/grill-with-docs/SKILL.md",
  ]) {
    assert.ok(existsSync(join(repoRoot, f)), `engineering must install ${f}`);
  }
});

test("transition matrix: lock manager.profile matches the active engineering profile", async (t) => {
  const { readFile } = await import("node:fs/promises");
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  const r = cli(repoRoot, [
    "init", "--profile", "engineering", "--json",
    "--planner-model", "fake/strong-planner",
    "--builder-model", "fake/cheap-builder",
    "--final-reviewer-model", "fake/strong-reviewer",
  ]);
  assert.equal(r.code, 0, r.stderr);
  const lock = JSON.parse(await readFile(join(repoRoot, ".opencode/ship.lock.json"), "utf8"));
  assert.equal(lock.manager.profile, "engineering");
  assert.equal(lock.manager.setupComplete, true);
});

test("transition matrix: persisted legacy core lock is promoted to engineering on next init", async (t) => {
  const { readFile } = await import("node:fs/promises");
  const fs = await import("node:fs/promises");
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  await fs.mkdir(join(repoRoot, ".opencode"), { recursive: true });
  await fs.writeFile(join(repoRoot, ".opencode", "ship.config.json"), JSON.stringify({
    schemaVersion: 1, profile: "core",
  }));
  const r = cli(repoRoot, [
    "init", "--json",
    "--planner-model", "fake/strong-planner",
    "--builder-model", "fake/cheap-builder",
    "--final-reviewer-model", "fake/strong-reviewer",
  ]);
  assert.equal(r.code, 0, r.stderr);
  const lock = JSON.parse(await readFile(join(repoRoot, ".opencode/ship.lock.json"), "utf8"));
  assert.equal(lock.manager.profile, "engineering");
});
