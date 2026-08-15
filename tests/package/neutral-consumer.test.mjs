/*
 * Neutral consumer qualification.
 *
 * The qualification covers the basic consumer lifecycle on a
 * packed tarball:
 *   - core init from a fresh repository
 *   - core → engineering transition
 *   - engineering → core downgrade
 *   - uninstall restores the preinstall state
 *
 * The transition matrix is exercised end-to-end against a
 * tarball built from the current source tree so a regression
 * in the installer's transaction layer surfaces before the
 * maintainer reaches for `npm publish`.
 *
 * The full neutral-dogfood (with planning, compaction, mirror
 * restore, and final review) is covered by the 0.10.0
 * registry-sourced dogfood in Task 14. This file is the unit-
 * level qualification that runs in `npm run verify` on every
 * commit.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { tar } from "./_test-tar.mjs";

const PKG_ROOT = process.cwd();

async function packAndExtract() {
  const tmp = await mkdtemp(join(tmpdir(), "opencode-ship-qual-"));
  const pack = spawnSync("npm", ["pack", "--pack-destination", tmp, "--json", "--silent"], {
    cwd: PKG_ROOT, encoding: "utf8",
  });
  assert.equal(pack.status, 0, pack.stderr);
  const meta = JSON.parse(pack.stdout);
  const tarballPath = join(tmp, meta[0].filename);
  const consumer = join(tmp, "consumer");
  await mkdir(consumer, { recursive: true });
  await tar.extract(tarballPath, consumer);
  return { tmp, consumer, packageDir: join(consumer, "package"), tarballPath };
}

async function makeBareOrigin() {
  const dir = await mkdtemp(join(tmpdir(), "ocd-bare-"));
  spawnSync("git", ["init", "--quiet", "--bare", "-b", "main"], { cwd: dir, encoding: "utf8" });
  return dir;
}

async function makeConsumerRepo(origin) {
  const dir = await mkdtemp(join(tmpdir(), "ocd-consumer-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@local", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@local" };
  spawnSync("git", ["init", "--quiet", "--initial-branch", "main"], { cwd: dir, env });
  spawnSync("git", ["config", "user.email", "t@local"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "consumer", version: "0.0.0", private: true }));
  await writeFile(join(dir, "README.md"), "# consumer\n");
  spawnSync("git", ["add", "."], { cwd: dir, env });
  spawnSync("git", ["commit", "-m", "init", "--no-gpg-sign"], { cwd: dir, env });
  if (origin) {
    spawnSync("git", ["remote", "add", "origin", origin], { cwd: dir, env });
  }
  return dir;
}

test("neutral: core init from a packed tarball on a fresh repo succeeds", async (t) => {
  const { tmp, consumer, packageDir } = await packAndExtract();
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const origin = await makeBareOrigin();
  t.after(async () => rm(origin, { recursive: true, force: true }));
  const repo = await makeConsumerRepo(origin);
  t.after(async () => rm(repo, { recursive: true, force: true }));

  const r = spawnSync("node", [join(packageDir, "dist/cli.js"), "init", "--root", repo, "--json"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(repo, ".opencode/plugins/opencode-ship.js")));
  assert.ok(existsSync(join(repo, ".opencode/ship.lock.json")));
  const lock = JSON.parse(readFileSync(join(repo, ".opencode/ship.lock.json"), "utf8"));
  assert.equal(lock.manager.profile, "core");
});

test("neutral: engineering init records the Plan Mode pointer", async (t) => {
  const { tmp, consumer, packageDir } = await packAndExtract();
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const origin = await makeBareOrigin();
  t.after(async () => rm(origin, { recursive: true, force: true }));
  const repo = await makeConsumerRepo(origin);
  t.after(async () => rm(repo, { recursive: true, force: true }));

  // The engineering profile requires explicit models before any
  // write. The fail-closed planner leaves the project in core
  // state when the models are missing, so the test must supply
  // them via the available CLI flags.
  const r = spawnSync("node", [
    join(packageDir, "dist/cli.js"), "init", "--root", repo, "--json",
    "--profile", "engineering",
    "--planner-model", "fake/strong-planner",
    "--builder-model", "fake/cheap-builder",
    "--final-reviewer-model", "fake/strong-reviewer",
    "--force-config",
  ], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const lock = JSON.parse(readFileSync(join(repo, ".opencode/ship.lock.json"), "utf8"));
  const pointers = (lock.manager?.rootDocuments ?? []).flatMap((d) => d.pointers ?? []);
  const planMode = pointers.find((p) => p.pointer === "/agent/plan/permission");
  assert.ok(planMode, "engineering init must record the Plan Mode pointer");
  assert.equal(planMode.scope, "engineering");
});

test("neutral: engineering -> core removes the Plan Mode pointer and engineering files", async (t) => {
  const { tmp, consumer, packageDir } = await packAndExtract();
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const origin = await makeBareOrigin();
  t.after(async () => rm(origin, { recursive: true, force: true }));
  const repo = await makeConsumerRepo(origin);
  t.after(async () => rm(repo, { recursive: true, force: true }));

  const r1 = spawnSync("node", [
    join(packageDir, "dist/cli.js"), "init", "--root", repo, "--json",
    "--profile", "engineering",
    "--planner-model", "fake/strong-planner",
    "--builder-model", "fake/cheap-builder",
    "--final-reviewer-model", "fake/strong-reviewer",
    "--force-config",
  ], { encoding: "utf8" });
  assert.equal(r1.status, 0, r1.stderr);
  assert.ok(existsSync(join(repo, ".opencode/skills/triage/SKILL.md")));

  const r2 = spawnSync("node", [join(packageDir, "dist/cli.js"), "init", "--root", repo, "--json", "--profile", "core"], { encoding: "utf8" });
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(existsSync(join(repo, ".opencode/skills/triage/SKILL.md")), false, "engineering skill must be removed on downgrade");
  const lock = JSON.parse(readFileSync(join(repo, ".opencode/ship.lock.json"), "utf8"));
  const pointers = (lock.manager?.rootDocuments ?? []).flatMap((d) => d.pointers ?? []);
  const planMode = pointers.find((p) => p.pointer === "/agent/plan/permission");
  assert.equal(planMode, undefined, "Plan Mode pointer must be removed on downgrade");
});

test("neutral: uninstall removes the lock and the managed files", async (t) => {
  const { tmp, consumer, packageDir } = await packAndExtract();
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const origin = await makeBareOrigin();
  t.after(async () => rm(origin, { recursive: true, force: true }));
  const repo = await makeConsumerRepo(origin);
  t.after(async () => rm(repo, { recursive: true, force: true }));

  const r1 = spawnSync("node", [join(packageDir, "dist/cli.js"), "init", "--root", repo, "--json"], { encoding: "utf8" });
  assert.equal(r1.status, 0, r1.stderr);
  const r2 = spawnSync("node", [join(packageDir, "dist/cli.js"), "uninstall", "--root", repo, "--json"], { encoding: "utf8" });
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(existsSync(join(repo, ".opencode/ship.lock.json")), false, "uninstall must remove the lock");
  assert.equal(existsSync(join(repo, ".opencode/plugins/opencode-ship.js")), false, "uninstall must remove the plugin");
});

function ghAuthToken() {
  // The doctor `gh auth status` check refuses to run unless
  // GH_TOKEN / GITHUB_TOKEN is set in the environment, even when
  // the host has a valid keyring session. The neutral-consumer
  // qualification therefore has to materialise a real token from
  // the existing keyring session so the doctor check has a
  // chance to exit 0. CI runners must wire `${{
  // secrets.GITHUB_TOKEN }}` (or equivalent) into
  // `OPENCODE_SHIP_GH_TOKEN`; otherwise the test self-skips.
  if (process.env.OPENCODE_SHIP_GH_TOKEN) return process.env.OPENCODE_SHIP_GH_TOKEN;
  const probe = spawnSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (probe.status === 0) return probe.stdout.trim();
  return null;
}

test("neutral: doctor reports the active profile footprint", async (t) => {
  const ghToken = ghAuthToken();
  if (!ghToken) {
    t.skip("gh auth token is not available; set OPENCODE_SHIP_GH_TOKEN to force");
    return;
  }
  const { tmp, consumer, packageDir } = await packAndExtract();
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const origin = await makeBareOrigin();
  t.after(async () => rm(origin, { recursive: true, force: true }));
  const repo = await makeConsumerRepo(origin);
  t.after(async () => rm(repo, { recursive: true, force: true }));

  // The engineering profile requires explicit model IDs before
  // any write. This test asserts that the installer's `init`
  // command succeeds only when those flags are present, then
  // re-runs `doctor` and asserts both the install and the doctor
  // report a noop profile footprint.
  const init = spawnSync("node", [
    join(packageDir, "dist/cli.js"),
    "init", "--root", repo, "--json",
    "--profile", "engineering",
    "--planner-model", "fake/strong-planner",
    "--builder-model", "fake/cheap-builder",
    "--final-reviewer-model", "fake/strong-reviewer",
    "--force-config",
  ], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr || init.stdout);
  const r = spawnSync("node", [join(packageDir, "dist/cli.js"), "doctor", "--root", repo, "--json"], {
    encoding: "utf8",
    env: { ...process.env, GH_TOKEN: ghToken },
  });
  assert.equal(r.status, 0, `doctor must exit 0 after a clean engineering install; stderr=${r.stderr} stdout=${r.stdout}`);
  const out = JSON.parse(r.stdout);
  assert.ok(Array.isArray(out.plan));
  const footprint = out.plan.find((c) => c.target === "profile footprint");
  assert.ok(footprint);
  assert.equal(footprint.kind, "noop", `profile footprint check failed: ${footprint.reason}`);
});

test("neutral: engineering init without model IDs fails before any write", async (t) => {
  // The engineering profile is fail-closed: when the consumer
  // (or CI matrix lane) tries to install it without explicit
  // model IDs, the installer must refuse and leave no managed
  // files behind. This guards against a regression where the
  // installer silently falls back to defaults and produces a
  // half-configured engineering install.
  const { tmp, consumer, packageDir } = await packAndExtract();
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const origin = await makeBareOrigin();
  t.after(async () => rm(origin, { recursive: true, force: true }));
  const repo = await makeConsumerRepo(origin);
  t.after(async () => rm(repo, { recursive: true, force: true }));

  const r = spawnSync("node", [
    join(packageDir, "dist/cli.js"), "init", "--root", repo, "--json",
    "--profile", "engineering",
  ], { encoding: "utf8" });
  assert.notEqual(r.status, 0, `engineering init without models must fail; stdout=${r.stdout}`);
  // The installer must not write any managed file when the
  // engineering profile is missing required model IDs.
  assert.equal(existsSync(join(repo, ".opencode/plugins/opencode-ship.js")), false, "plugin must not be written");
  assert.equal(existsSync(join(repo, ".opencode/ship.lock.json")), false, "lock must not be written");
  assert.equal(existsSync(join(repo, ".opencode/ship.config.json")), false, "ship config must not be written");
});

test("neutral: engineering init with partial model IDs fails before any write", async (t) => {
  // The fail-closed check applies to every required role, not
  // just to "all three missing". Supplying one or two IDs but
  // omitting the rest must also refuse the install.
  const { tmp, consumer, packageDir } = await packAndExtract();
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const origin = await makeBareOrigin();
  t.after(async () => rm(origin, { recursive: true, force: true }));
  const repo = await makeConsumerRepo(origin);
  t.after(async () => rm(repo, { recursive: true, force: true }));

  for (const missing of ["builder", "finalReviewer"]) {
    const args = [
      join(packageDir, "dist/cli.js"), "init", "--root", repo, "--json",
      "--profile", "engineering",
      "--planner-model", "fake/strong-planner",
    ];
    if (missing !== "builder") args.push("--builder-model", "fake/cheap-builder");
    if (missing !== "finalReviewer") args.push("--final-reviewer-model", "fake/strong-reviewer");
    const r = spawnSync("node", args, { encoding: "utf8" });
    assert.notEqual(r.status, 0, `engineering init missing ${missing} must fail`);
    assert.equal(existsSync(join(repo, ".opencode/plugins/opencode-ship.js")), false, `plugin must not be written when ${missing} is missing`);
    assert.equal(existsSync(join(repo, ".opencode/ship.lock.json")), false, `lock must not be written when ${missing} is missing`);
    // Reset between iterations so each missing-role case starts
    // from a clean repo.
    spawnSync("git", ["reset", "--hard"], { cwd: repo, env: process.env });
    spawnSync("git", ["clean", "-fd"], { cwd: repo, env: process.env });
  }
});
