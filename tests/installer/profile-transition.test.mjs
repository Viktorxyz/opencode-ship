/*
 * End-to-end migration test: a legacy "core" install must be
 * upgraded to "engineering" on the next `init` or `update`. After
 * upgrade the lock must carry `manager.profile: "engineering"`,
 * `manager.setupComplete` must reflect the config state, and any
 * engineering-only entry the consumer was missing must be added.
 *
 * The CLI must refuse `--profile core` with exit 2 because the
 * user can no longer opt into the removed profile for new installs.
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

test("init: --profile engineering installs the engineering-only entries", async (t) => {
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

test("init: --profile core exits 2 with a clear error (core removed in 1.1.0)", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  const r = cli(repoRoot, ["init", "--profile", "core", "--json"]);
  assert.equal(r.code, 2, JSON.stringify(r, null, 2));
  assert.match(r.stderr, /core/);
  assert.match(r.stderr, /removed/i);
});

test("init: persisted legacy lock with profile=core is promoted to engineering", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  // Seed a legacy v3-style lock with profile=core. The installer
  // must accept the read and promote to engineering.
  const legacyLock = {
    contractVersion: 3,
    manager: {
      schemaVersion: 3,
      name: "opencode-ship",
      version: "1.0.0",
      profile: "core",
      appliedAt: "2026-07-01T00:00:00.000Z",
      config: { path: ".opencode/ship.config.json", sha256: "", existed: false },
      rootDocuments: [],
    },
    files: [],
    integrity: { lockSha256: "ignored" },
  };
  // Compute proper integrity for the legacy body so validation passes.
  const { computeIntegrity } = await import("../../src/installer/lock.js");
  legacyLock.integrity = computeIntegrity(legacyLock);
  const fs = await import("node:fs/promises");
  await fs.mkdir(join(repoRoot, ".opencode"), { recursive: true });
  await fs.writeFile(join(repoRoot, ".opencode", "ship.lock.json"), JSON.stringify(legacyLock, null, 2));
  await fs.writeFile(
    join(repoRoot, ".opencode", "ship.config.json"),
    JSON.stringify({
      schemaVersion: 1,
      profile: "core",
    }, null, 2),
  );

  const r = cli(repoRoot, [
    "init", "--json",
    "--planner-model", "fake/strong-planner",
    "--builder-model", "fake/cheap-builder",
    "--final-reviewer-model", "fake/strong-reviewer",
  ]);
  assert.equal(r.code, 0, r.stderr);
  const lock = JSON.parse(readFileSync(join(repoRoot, ".opencode/ship.lock.json"), "utf8"));
  assert.equal(lock.manager.profile, "engineering");
  // init no longer elevates setupComplete; only the explicit
  // `setup-complete` command does.
  assert.equal(lock.manager.setupComplete, false);
});

test("init: persisted legacy ship.config.json with profile=core is promoted to engineering", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  const fs = await import("node:fs/promises");
  await fs.mkdir(join(repoRoot, ".opencode"), { recursive: true });
  await fs.writeFile(
    join(repoRoot, ".opencode", "ship.config.json"),
    JSON.stringify({ schemaVersion: 1, profile: "core" }, null, 2),
  );
  const r = cli(repoRoot, [
    "init", "--json",
    "--planner-model", "fake/strong-planner",
    "--builder-model", "fake/cheap-builder",
    "--final-reviewer-model", "fake/strong-reviewer",
  ]);
  assert.equal(r.code, 0, r.stderr);
  const lock = JSON.parse(readFileSync(join(repoRoot, ".opencode/ship.lock.json"), "utf8"));
  assert.equal(lock.manager.profile, "engineering");
});
