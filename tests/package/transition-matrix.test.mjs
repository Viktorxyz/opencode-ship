/*
 * Engineering profile transition matrix smoke (lite).
 *
 * Verifies the core↔engineering transition produces the right
 * set of files for each profile. The full E2E install
 * (`pnpm dlx opencode-ship@latest`) is exercised by
 * `tests/installer/installer-cli.test.mjs`; this module focuses
 * on the profile-transition shape so the smoke runs in the
 * default `npm run verify` pipeline.
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

test("transition matrix: core init omits engineering-only files", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  const r = cli(repoRoot, ["init", "--profile", "core", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  for (const f of [
    ".opencode/skills/triage/SKILL.md",
    ".opencode/skills/grill-with-docs/SKILL.md",
  ]) {
    assert.equal(existsSync(join(repoRoot, f)), false, `core must not install ${f}`);
  }
});

test("transition matrix: engineering init adds engineering-only files", async (t) => {
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

test("transition matrix: lock manager.profile matches the active profile", async (t) => {
  const { readFile } = await import("node:fs/promises");
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  cli(repoRoot, ["init", "--profile", "core", "--json"]);
  const lockCore = JSON.parse(await readFile(join(repoRoot, ".opencode/ship.lock.json"), "utf8"));
  assert.equal(lockCore.manager.profile, "core");
  cli(repoRoot, [
    "init", "--profile", "engineering", "--json",
    "--planner-model", "fake/strong-planner",
    "--builder-model", "fake/cheap-builder",
    "--final-reviewer-model", "fake/strong-reviewer",
  ]);
  const lockEng = JSON.parse(await readFile(join(repoRoot, ".opencode/ship.lock.json"), "utf8"));
  assert.equal(lockEng.manager.profile, "engineering");
});
