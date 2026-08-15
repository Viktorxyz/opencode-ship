/*
 * End-to-end transition test: init with core, then init with
 * engineering. The plan should ADD the engineering-only entries
 * (triage, grill-with-docs) and not touch the core entries.
 *
 * Reverse direction: init with engineering first, then core.
 * The plan should REMOVE the engineering-only entries (covered
 * by the conflict path because the user has modified them, so
 * they need --replace-managed to actually drop — but the LIST of
 * removal candidates is present in the plan).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { makeProject, cleanProject } from "../fixtures/installer-fixture.mjs";

const CLI = resolve("dist/cli.js");

function cli(repoRoot, args) {
  const r = spawnSync("node", [CLI, ...args, "--root", repoRoot], { encoding: "utf8" });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

test("init: core profile installs only the core entries", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  const r = cli(repoRoot, ["init", "--profile", "core", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  for (const p of [".opencode/skills/triage/SKILL.md", ".opencode/skills/grill-with-docs/SKILL.md"]) {
    assert.equal(
      existsSync(join(repoRoot, p)),
      false,
      `core profile must not install ${p}`,
    );
  }
});

test("init: engineering profile installs the engineering-only entries", async (t) => {
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
  for (const p of [".opencode/skills/triage/SKILL.md", ".opencode/skills/grill-with-docs/SKILL.md"]) {
    assert.ok(existsSync(join(repoRoot, p)), `engineering profile must install ${p}`);
  }
  const lock = JSON.parse(readFileSync(join(repoRoot, ".opencode/ship.lock.json"), "utf8"));
  assert.equal(lock.manager.profile, "engineering");
});

test("init: lock manager.profile transitions core → engineering correctly", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  cli(repoRoot, ["init", "--profile", "core", "--json"]);
  const r2 = cli(repoRoot, [
    "init", "--profile", "engineering", "--json",
    "--planner-model", "fake/strong-planner",
    "--builder-model", "fake/cheap-builder",
    "--final-reviewer-model", "fake/strong-reviewer",
  ]);
  assert.equal(r2.code, 0, r2.stderr);
  const lock = JSON.parse(readFileSync(join(repoRoot, ".opencode/ship.lock.json"), "utf8"));
  assert.equal(lock.manager.profile, "engineering");
  // The engineering-only entries must now be in the lock
  const relPaths = (lock.files ?? []).map((f) => f.path);
  assert.ok(relPaths.includes(".opencode/skills/triage/SKILL.md"));
  assert.ok(relPaths.includes(".opencode/skills/grill-with-docs/SKILL.md"));
});
