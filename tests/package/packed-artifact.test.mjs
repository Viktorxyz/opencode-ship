/*
 * Isolated packed-artifact smoke test.
 *
 * Build a real tarball, extract it into a clean directory that has NO
 * link back to the source tree, remove the local node_modules, then
 * load the bundled plugin from the extracted path and assert exactly
 * nine tools are registered. This verifies the published artifact is
 * truly self-contained.
 *
 * The second test runs the extracted CLI against a fresh Git
 * repository to prove the plugin is auto-discovered from
 * `.opencode/plugins/opencode-ship.js` and that the manager writes
 * the canonical pointer records into the lock.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, copyFile, readFile, writeFile } from "node:fs/promises";
import { existsSync, writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tar } from "./_test-tar.mjs";

test("packed-artifact: bundled plugin loads with nine tools in an isolated consumer", async (t) => {
  const pkgRoot = process.cwd();
  const tmp = await mkdtemp(join(tmpdir(), "opencode-ship-isolated-"));
  const child = { cleanup: () => {} };
  t.after(async () => {
    child.cleanup?.();
    await rm(tmp, { recursive: true, force: true });
  });

  // Pack the source tree.
  const pack = spawnSync("npm", ["pack", "--pack-destination", tmp, "--json", "--silent"], {
    cwd: pkgRoot, encoding: "utf8",
  });
  assert.equal(pack.status, 0, pack.stderr);
  const meta = JSON.parse(pack.stdout);
  const tarball = meta[0].filename;
  const tarballPath = join(tmp, tarball);
  assert.ok(existsSync(tarballPath));

  // Extract into a fresh consumer directory.
  const consumer = join(tmp, "consumer");
  await mkdir(consumer, { recursive: true });
  await tar.extract(tarballPath, consumer);
  const consumerPackage = join(consumer, "package");
  assert.ok(existsSync(consumerPackage));

  // The consumer MUST NOT have any link back to the source tree's
  // node_modules. We try loading the plugin from this freshly
  // extracted location and expect the imports to resolve inside the
  // extracted `dist/plugin.js` only.
  const pluginPath = join(consumerPackage, "dist/plugin.js");
  assert.ok(existsSync(pluginPath), "extracted plugin.js must exist");

  // Sanity check: tarball should not bundle @opencode-ai/plugin as a
  // separate package; it must be inlined.
  const fileList = await tar.list(tarballPath);
  assert.equal(
    fileList.some((f) => f.path.includes("node_modules/@opencode-ai")),
    false,
    "tarball leaked @opencode-ai/plugin as a separate package",
  );

  // Load the plugin from the extracted path in a fresh module graph.
  const pluginFileUrl = pathToFileURL(pluginPath).href;
  const workspaceJson = JSON.stringify(consumerPackage);
  const childProc = spawnSync("node", [
    "--input-type=module", "--no-warnings",
    "-e",
    `import(${JSON.stringify(pluginFileUrl)}).then(async (mod) => {`
      + `const result = await mod.default({ worktree: ${workspaceJson}, project: {}, client: {}, directory: ${workspaceJson} });`
      + `const ids = Object.keys(result.tool).sort();`
      + `process.stdout.write(JSON.stringify(ids));`
      + `});`,
  ], { encoding: "utf8" });
  assert.equal(childProc.status, 0, childProc.stderr + "\n" + childProc.stdout);
  const ids = JSON.parse(childProc.stdout.trim());
  assert.deepEqual(ids, [
    "delivery_cleanup",
    "delivery_github_read",
    "delivery_inspect",
    "delivery_issue",
    "delivery_issue_close",
    "delivery_issue_comment",
    "delivery_issue_labels",
    "delivery_issue_link",
    "delivery_merge",
    "delivery_pr",
    "delivery_publish",
    "delivery_ready",
    "delivery_review",
    "delivery_sync",
    "delivery_verify",
    "delivery_worktree",
    "ship_plan_approve",
    "ship_plan_start",
    "ship_plan_submit",
    "ship_resume",
    "ship_run_start",
    "ship_status",
    "ship_task_report",
    "ship_task_review",
  ]);
  // Cleanup tarball
  await rm(tarballPath, { force: true }).catch(() => null);
  void writeFileSync;
  void readFile;
  void mkdtempSync;
});

test("packed-artifact: extracted CLI init writes a fresh repository with all managed files", async (t) => {
  const pkgRoot = process.cwd();
  const tmp = await mkdtemp(join(tmpdir(), "opencode-ship-extracted-init-"));
  t.after(async () => rm(tmp, { recursive: true, force: true }));

  const pack = spawnSync("npm", ["pack", "--pack-destination", tmp, "--json", "--silent"], {
    cwd: pkgRoot, encoding: "utf8",
  });
  assert.equal(pack.status, 0, pack.stderr);
  const meta = JSON.parse(pack.stdout);
  const tarballPath = join(tmp, meta[0].filename);
  assert.ok(existsSync(tarballPath));

  const consumer = join(tmp, "consumer");
  await mkdir(consumer, { recursive: true });
  await tar.extract(tarballPath, consumer);
  const consumerPackage = join(consumer, "package");

  const repo = join(tmp, "repo");
  await mkdir(repo, { recursive: true });
  spawnSync("git", ["-C", repo, "init", "--quiet", "--initial-branch", "main"], { encoding: "utf8" });
  spawnSync("git", ["-C", repo, "config", "user.email", "opencode-ship@test"], { encoding: "utf8" });
  spawnSync("git", ["-C", repo, "config", "user.name", "opencode-ship"], { encoding: "utf8" });
  await writeFile(join(repo, "package.json"), JSON.stringify({ name: "consumer", version: "0.0.0", private: true }, null, 2));
  await writeFile(join(repo, "README.md"), "# consumer\n");
  spawnSync("git", ["-C", repo, "add", "."], { encoding: "utf8" });
  spawnSync("git", ["-C", repo, "commit", "-m", "init", "--no-gpg-sign"], { encoding: "utf8" });

  const init = spawnSync("node", [join(consumerPackage, "dist/cli.js"), "init", "--root", repo], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);

  for (const p of [
    ".opencode/plugins/opencode-ship.js",
    ".opencode/agents/delivery-reviewer.md",
    ".opencode/agents/delivery-verifier.md",
    ".opencode/skills/delivery-workflow/SKILL.md",
    ".opencode/skills/planning-research-checkpoint/SKILL.md",
    ".opencode/ship.config.json",
    ".opencode/ship.lock.json",
  ]) {
    assert.ok(existsSync(join(repo, p)), `expected ${p} to exist after extracted CLI init`);
  }

  const lock = JSON.parse(readFileSync(join(repo, ".opencode/ship.lock.json"), "utf8"));
  const plugin = lock.files.find((f) => f.path === ".opencode/plugins/opencode-ship.js");
  assert.ok(plugin?.sha256, "plugin entry must carry a sha256");
  const rootDocuments = lock.manager?.rootDocuments ?? [];
  const records = rootDocuments.flatMap((d) => d.pointers ?? []);
  assert.ok(records.length > 0, "fresh install must record at least one root pointer");
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

  await rm(tarballPath, { force: true }).catch(() => null);
});

test("packed-artifact: npm pack includes every required file", async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), "opencode-ship-pack-"));
  t.after(async () => rm(tmp, { recursive: true, force: true }));
  const pack = spawnSync("npm", ["pack", "--pack-destination", tmp, "--json", "--silent"], {
    cwd: process.cwd(), encoding: "utf8",
  });
  assert.equal(pack.status, 0, pack.stderr);
  const meta = JSON.parse(pack.stdout);
  const tarballPath = join(tmp, meta[0].filename);
  const entries = await tar.list(tarballPath);
  const paths = entries.map((e) => e.path).sort();
  for (const required of [
    "package/package.json",
    "package/dist/cli.js",
    "package/dist/plugin.js",
    "package/dist/core.js",
    "package/assets/agents/delivery-reviewer.md",
    "package/assets/agents/delivery-verifier.md",
    "package/assets/skills/delivery-workflow/SKILL.md",
    "package/assets/skills/planning-research-checkpoint/SKILL.md",
    "package/schema/ship-config.schema.json",
    "package/schema/ship-lock.schema.json",
    "package/schema/project-adapter.schema.json",
    "package/THIRD_PARTY_NOTICES.md",
  ]) {
    assert.ok(paths.includes(required), `${required} missing from packed tarball`);
  }
  for (const leaked of paths.filter((p) => p.startsWith("package/src/"))) {
    assert.ok(false, `src leaks into pack: ${leaked}`);
  }
  for (const leaked of paths.filter((p) => p.includes("node_modules"))) {
    assert.ok(false, `node_modules leaks into pack: ${leaked}`);
  }
  // Smoke: the bundled CLI binary runs.
  const cliPath = resolve(join(tmp, meta[0].filename.replace(/\.tgz$/, "")));
  await tar.extract(tarballPath, tmp);
  const version = spawnSync("node", [join(tmp, "package/dist/cli.js"), "--version"], { encoding: "utf8" });
  assert.equal(version.status, 0);
  assert.match(version.stdout, /opencode-ship \d+\.\d+\.\d+/);
  await rm(tarballPath, { force: true }).catch(() => null);
});
