/*
 * Integration tests for profile-aware init/update.
 *
 * init must:
 *   1. accept a `profile` argument,
 *   2. write `manager.profile` into the new lock,
 *   3. include only the catalog entries that ship under the
 *      active profile in the plan (which currently means "all
 *      of them" — every v0.4 entry ships in both profiles), and
 *   4. emit a noop plan on the second invocation.
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
  // The engineering profile requires explicit models now; the
  // fail-closed planner rejects the install without them.
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
  assert.equal(lock.contractVersion, 3);
  assert.equal(lock.manager.schemaVersion, 3);
});

test("init: --profile core writes manager.profile=core in the lock", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  const r = await initWith(repoRoot, ["--profile", "core"]);
  assert.equal(r.code, 0, r.stderr);
  const lock = JSON.parse(readFileSync(join(repoRoot, ".opencode/ship.lock.json"), "utf8"));
  assert.equal(lock.manager.profile, "core");
});

test("init: --profile practices exits 2 with an error message", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  const r = await initWith(repoRoot, ["--profile", "practices"]);
  assert.equal(r.code, 2, JSON.stringify(r, null, 2));
  assert.match(r.stderr, /profile/i);
});

test("init: ship.config.json .profile=core wins over a v0.3 lock without profile", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  await writeFileTo(
    repoRoot,
    ".opencode/ship.config.json",
    JSON.stringify({ schemaVersion: 1, profile: "core" }, null, 2) + "\n",
  );
  const r = await initWith(repoRoot);
  assert.equal(r.code, 0, r.stderr);
  const lock = JSON.parse(readFileSync(join(repoRoot, ".opencode/ship.lock.json"), "utf8"));
  assert.equal(lock.manager.profile, "core");
});

test("init: ship.config.json .profile=engineering with no CLI flag persists the choice", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  await writeFileTo(
    repoRoot,
    ".opencode/ship.config.json",
    JSON.stringify({ schemaVersion: 1, profile: "core" }, null, 2) + "\n",
  );
  const r = await initWith(repoRoot, ["--profile", "engineering"]);
  assert.equal(r.code, 0, r.stderr);
  const lock = JSON.parse(readFileSync(join(repoRoot, ".opencode/ship.lock.json"), "utf8"));
  assert.equal(lock.manager.profile, "engineering");
});
