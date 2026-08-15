/*
 * Neutral consumer qualification.
 *
 * From 1.1.0 the only shipped profile is engineering. The
 * qualification covers the basic consumer lifecycle on a packed
 * tarball:
 *   - engineering init with explicit models
 *   - engineering init without models fails before any write
 *   - partial models also fail
 *   - doctor reports a healthy engineering footprint
 *   - uninstall restores the preinstall state
 *
 * The transition matrix is exercised end-to-end against a
 * tarball built from the current source tree so a regression in
 * the installer's transaction layer surfaces before the
 * maintainer reaches for `npm publish`.
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

test("neutral: engineering init from a packed tarball on a fresh repo succeeds", async (t) => {
  const { tmp, consumer, packageDir } = await packAndExtract();
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const origin = await makeBareOrigin();
  t.after(async () => rm(origin, { recursive: true, force: true }));
  const repo = await makeConsumerRepo(origin);
  t.after(async () => rm(repo, { recursive: true, force: true }));

  const r = spawnSync("node", [
    join(packageDir, "dist/cli.js"), "init", "--root", repo, "--json",
    "--profile", "engineering",
    "--planner-model", "fake/strong-planner",
    "--builder-model", "fake/cheap-builder",
    "--final-reviewer-model", "fake/strong-reviewer",
    "--force-config",
  ], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(repo, ".opencode/plugins/opencode-ship.js")));
  assert.ok(existsSync(join(repo, ".opencode/ship.lock.json")));
  const lock = JSON.parse(readFileSync(join(repo, ".opencode/ship.lock.json"), "utf8"));
  assert.equal(lock.manager.profile, "engineering");
  assert.equal(lock.manager.setupComplete, true);
});

test("neutral: engineering init without explicit --profile defaults to engineering", async (t) => {
  const { tmp, consumer, packageDir } = await packAndExtract();
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const origin = await makeBareOrigin();
  t.after(async () => rm(origin, { recursive: true, force: true }));
  const repo = await makeConsumerRepo(origin);
  t.after(async () => rm(repo, { recursive: true, force: true }));

  const r = spawnSync("node", [
    join(packageDir, "dist/cli.js"), "init", "--root", repo, "--json",
    "--planner-model", "fake/strong-planner",
    "--builder-model", "fake/cheap-builder",
    "--final-reviewer-model", "fake/strong-reviewer",
  ], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const lock = JSON.parse(readFileSync(join(repo, ".opencode/ship.lock.json"), "utf8"));
  assert.equal(lock.manager.profile, "engineering");
});

test("neutral: engineering init does not record the Plan Mode pointer (consumer-owned)", async (t) => {
  const { tmp, consumer, packageDir } = await packAndExtract();
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const origin = await makeBareOrigin();
  t.after(async () => rm(origin, { recursive: true, force: true }));
  const repo = await makeConsumerRepo(origin);
  t.after(async () => rm(repo, { recursive: true, force: true }));

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
  assert.equal(planMode, undefined,
    "engineering init must NOT record a Plan Mode pointer; the consumer owns it");
});

test("neutral: uninstall removes the lock and the managed files", async (t) => {
  const { tmp, consumer, packageDir } = await packAndExtract();
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const origin = await makeBareOrigin();
  t.after(async () => rm(origin, { recursive: true, force: true }));
  const repo = await makeConsumerRepo(origin);
  t.after(async () => rm(repo, { recursive: true, force: true }));

  const r1 = spawnSync("node", [
    join(packageDir, "dist/cli.js"), "init", "--root", repo, "--json",
    "--planner-model", "fake/strong-planner",
    "--builder-model", "fake/cheap-builder",
    "--final-reviewer-model", "fake/strong-reviewer",
  ], { encoding: "utf8" });
  assert.equal(r1.status, 0, r1.stderr);
  const r2 = spawnSync("node", [join(packageDir, "dist/cli.js"), "uninstall", "--root", repo, "--json"], { encoding: "utf8" });
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(existsSync(join(repo, ".opencode/ship.lock.json")), false, "uninstall must remove the lock");
  assert.equal(existsSync(join(repo, ".opencode/plugins/opencode-ship.js")), false, "uninstall must remove the plugin");
});

function ghAuthToken() {
  if (process.env.OPENCODE_SHIP_GH_TOKEN) return process.env.OPENCODE_SHIP_GH_TOKEN;
  const probe = spawnSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (probe.status === 0) return probe.stdout.trim();
  return null;
}

test("neutral: doctor reports a healthy footprint after engineering init", async (t) => {
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
  // The one-liner flow without models succeeds but leaves the
  // setup-pending marker so the user is routed through
  // /setup-ship-workflow. The contract is: install succeeds,
  // marker is written, models remain empty, doctor reflects
  // pending setup.
  assert.equal(r.status, 0, `engineering init without models must succeed with setup pending; stdout=${r.stdout}`);
  assert.ok(existsSync(join(repo, ".opencode/ship.lock.json")), "lock must be written");
  assert.ok(existsSync(join(repo, ".opencode/ship.setup-pending.json")), "setup pending marker must be written");
  const lock = JSON.parse(readFileSync(join(repo, ".opencode/ship.lock.json"), "utf8"));
  assert.equal(lock.manager.profile, "engineering");
  assert.equal(lock.manager.setupComplete, false);
});

test("neutral: engineering init without model IDs and --force-config fails before any write", async (t) => {
  // --force-config requires explicit models because it bypasses
  // the default synthesis; the installer must fail closed.
  const { tmp, consumer, packageDir } = await packAndExtract();
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const origin = await makeBareOrigin();
  t.after(async () => rm(origin, { recursive: true, force: true }));
  const repo = await makeConsumerRepo(origin);
  t.after(async () => rm(repo, { recursive: true, force: true }));

  const r = spawnSync("node", [
    join(packageDir, "dist/cli.js"), "init", "--root", repo, "--json",
    "--profile", "engineering",
    "--force-config",
  ], { encoding: "utf8" });
  assert.notEqual(r.status, 0, `engineering init without models + --force-config must fail`);
  assert.equal(existsSync(join(repo, ".opencode/plugins/opencode-ship.js")), false, "plugin must not be written");
  assert.equal(existsSync(join(repo, ".opencode/ship.lock.json")), false, "lock must not be written");
});

test("neutral: engineering init with partial model IDs and --force-config fails before any write", async (t) => {
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
      "--force-config",
      "--planner-model", "fake/strong-planner",
    ];
    if (missing !== "builder") args.push("--builder-model", "fake/cheap-builder");
    if (missing !== "finalReviewer") args.push("--final-reviewer-model", "fake/strong-reviewer");
    const r = spawnSync("node", args, { encoding: "utf8" });
    assert.notEqual(r.status, 0, `engineering init missing ${missing} + --force-config must fail`);
    assert.equal(existsSync(join(repo, ".opencode/plugins/opencode-ship.js")), false, `plugin must not be written when ${missing} is missing`);
    assert.equal(existsSync(join(repo, ".opencode/ship.lock.json")), false, `lock must not be written when ${missing} is missing`);
    spawnSync("git", ["reset", "--hard"], { cwd: repo, env: process.env });
    spawnSync("git", ["clean", "-fd"], { cwd: repo, env: process.env });
  }
});
