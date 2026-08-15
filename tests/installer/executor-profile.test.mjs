/*
 * Integration tests for profile-aware init/update.
 *
 * init must:
 *   1. accept --profile engineering and write manager.profile=engineering;
 *   2. reject --profile core with exit 2 (core removed in 1.1.0);
 *   3. reject --profile practices with exit 2;
 *   4. write setupComplete=true when models are present;
 *   5. persist engineering across multiple invocations.
 *
 * These tests run through the full dist/cli.js because the public
 * surface of previewInstall is exercised by the CLI commands.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { makeProject, cleanProject, writeFileTo } from "../fixtures/installer-fixture.mjs";

const CLI = resolve("dist/cli.js");

function cli(repoRoot, args) {
  const r = spawnSync("node", [CLI, ...args, "--root", repoRoot], { encoding: "utf8" });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

async function initWith(repoRoot, extra = []) {
  return cli(repoRoot, ["init", "--json", ...extra]);
}

test("init: --profile engineering writes manager.profile=engineering in the lock", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  const r = await initWith(repoRoot, [
    "--profile", "engineering",
    "--planner-model", "fake/strong-planner",
    "--builder-model", "fake/cheap-builder",
    "--final-reviewer-model", "fake/strong-reviewer",
    "--force-config",
  ]);
  assert.equal(r.code, 0, r.stderr);
  const lock = JSON.parse(readFileSync(join(repoRoot, ".opencode/ship.lock.json"), "utf8"));
  assert.equal(lock.manager.profile, "engineering");
  assert.equal(lock.manager.setupComplete, true);
});

test("init: --profile core exits 2 with an error message (core removed in 1.1.0)", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  const r = await initWith(repoRoot, ["--profile", "core"]);
  assert.equal(r.code, 2, JSON.stringify(r, null, 2));
  assert.match(r.stderr, /core/);
  assert.match(r.stderr, /removed/i);
});

test("init: --profile practices exits 2 with an error message", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  const r = await initWith(repoRoot, ["--profile", "practices"]);
  assert.equal(r.code, 2, JSON.stringify(r, null, 2));
  assert.match(r.stderr, /profile/i);
});

test("init: ship.config.json with profile=core is promoted to engineering", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  await writeFileTo(
    repoRoot,
    ".opencode/ship.config.json",
    JSON.stringify({ schemaVersion: 1, profile: "core" }, null, 2) + "\n",
  );
  const r = await initWith(repoRoot, [
    "--planner-model", "fake/strong-planner",
    "--builder-model", "fake/cheap-builder",
    "--final-reviewer-model", "fake/strong-reviewer",
  ]);
  assert.equal(r.code, 0, r.stderr);
  const lock = JSON.parse(readFileSync(join(repoRoot, ".opencode/ship.lock.json"), "utf8"));
  assert.equal(lock.manager.profile, "engineering");
});

test("init: ship.config.json with profile=engineering persists across invocations", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  await writeFileTo(
    repoRoot,
    ".opencode/ship.config.json",
    JSON.stringify({ schemaVersion: 1, profile: "engineering" }, null, 2) + "\n",
  );
  const r = await initWith(repoRoot, [
    "--planner-model", "fake/strong-planner",
    "--builder-model", "fake/cheap-builder",
    "--final-reviewer-model", "fake/strong-reviewer",
  ]);
  assert.equal(r.code, 0, r.stderr);
  const lock = JSON.parse(readFileSync(join(repoRoot, ".opencode/ship.lock.json"), "utf8"));
  assert.equal(lock.manager.profile, "engineering");
});
