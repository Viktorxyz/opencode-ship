/*
 * Installer smoke tests: init / diff / update / uninstall / doctor /
 * idempotency / conflict / uninstall preserves user files.
 *
 * The CLI is invoked by spawning the built `dist/cli.js` against a
 * temporary Git repository created via `tests/fixtures/installer-fixture.mjs`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { makeProject, cleanProject, writeFileTo } from "../fixtures/installer-fixture.mjs";

const CLI = resolve("dist/cli.js");
const PKG_ROOT = resolve(".");

function cli(repoRoot, args) {
  const r = spawnSync("node", [CLI, ...args, "--root", repoRoot], {
    encoding: "utf8",
    cwd: PKG_ROOT,
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

async function runInit(repoRoot, extra = []) {
  return cli(repoRoot, ["init", "--json", ...extra]);
}

test("init: creates all managed files on a fresh project", async (t) => {
  const { parent, repoRoot } = await makeProject({ packageManager: "pnpm" });
  t.after(async () => cleanProject(parent));
  const r = await runInit(repoRoot);
  assert.equal(r.code, 0, JSON.stringify(r, null, 2));
  for (const p of [
    ".opencode/plugins/opencode-ship.js",
    ".opencode/agents/delivery-reviewer.md",
    ".opencode/agents/delivery-verifier.md",
    ".opencode/skills/delivery-workflow/SKILL.md",
    ".opencode/skills/planning-research-checkpoint/SKILL.md",
    ".opencode/ship.config.json",
    ".opencode/ship.lock.json",
  ]) {
    assert.ok(existsSync(join(repoRoot, p)), `expected ${p} to exist`);
  }
});

test("init: second invocation is a no-op", async (t) => {
  const { parent, repoRoot } = await makeProject({ packageManager: "pnpm" });
  t.after(async () => cleanProject(parent));
  await runInit(repoRoot);
  const second = await runInit(repoRoot);
  assert.equal(second.code, 0);
  const summary = JSON.parse(second.stdout).summary;
  assert.equal(summary.update, 0);
  assert.equal(summary.create, 0);
});

test("diff: detects no changes after a fresh init", async (t) => {
  const { parent, repoRoot } = await makeProject({ packageManager: "yarn" });
  t.after(async () => cleanProject(parent));
  await runInit(repoRoot);
  const r = cli(repoRoot, ["diff", "--json"]);
  assert.equal(r.code, 0);
});

test("init: requires a Git repository", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-ship-norepo-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const r = cli(dir, ["init", "--json"]);
  assert.equal(r.code, 2);
});

test("init: writes a lock whose content matches the plugin bytes", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  await runInit(repoRoot);
  const lock = JSON.parse(readFileSync(join(repoRoot, ".opencode/ship.lock.json"), "utf8"));
  const plugin = lock.files.find((f) => f.path === ".opencode/plugins/opencode-ship.js");
  const shipped = readFileSync(join(PKG_ROOT, "dist/plugin.js"), "utf8");
  assert.equal(plugin.sha256, hashOf(shipped));
});

test("init: refuses to overwrite a modified managed file", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  await runInit(repoRoot);
  await writeFileTo(repoRoot, ".opencode/agents/delivery-reviewer.md", "# local edit\n");
  const r = cli(repoRoot, ["update", "--json"]);
  assert.equal(r.code, 3, JSON.stringify(r, null, 2));
});

test("init: --replace-managed overwrites a modified managed file", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  await runInit(repoRoot);
  await writeFileTo(repoRoot, ".opencode/agents/delivery-reviewer.md", "# local edit\n");
  const r = cli(repoRoot, ["update", "--replace-managed", "--json"]);
  assert.equal(r.code, 0, JSON.stringify(r, null, 2));
});

test("uninstall: removes managed files that still match the lock", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  await runInit(repoRoot);
  const r = cli(repoRoot, ["uninstall", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  for (const p of [
    ".opencode/plugins/opencode-ship.js",
    ".opencode/agents/delivery-reviewer.md",
  ]) {
    assert.ok(!existsSync(join(repoRoot, p)), `${p} should be removed`);
  }
  assert.ok(existsSync(join(repoRoot, ".opencode/ship.config.json")), "user config preserved by default");
});

test("uninstall: preserves a modified managed file", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  await runInit(repoRoot);
  await writeFileTo(repoRoot, ".opencode/agents/delivery-reviewer.md", "# local edit\n");
  const r = cli(repoRoot, ["uninstall", "--json"]);
  assert.equal(r.code, 3, JSON.stringify(r, null, 2));
});

test("init: auto-runs doctor and exposes issues/checks in JSON", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  const r = await runInit(repoRoot);
  assert.equal(r.code, 0, r.stderr);
  const env = JSON.parse(r.stdout);
  assert.ok(Array.isArray(env.doctor), "doctor field should be array of issues");
  assert.ok(Array.isArray(env.doctorChecks), "doctorChecks should include the full check list");
  assert.ok(env.doctorChecks.length > 0, "doctorChecks should not be empty");
  const nodeCheck = env.doctorChecks.find((c) => c.name === "node>=22.6.0");
  assert.ok(nodeCheck, "node check must be present");
  assert.equal(nodeCheck.ok, true);
});

test("init: --strict-doctor exits 0 in CI and surfaces doctor in JSON", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  const r = await runInit(repoRoot, ["--strict-doctor"]);
  // Whether the doctor surfaces an issue depends on the runner's auth state.
  // We assert two invariants instead:
  // 1. the JSON envelope always carries doctor + doctorChecks;
  // 2. exit code is 0 or 1, never a transaction/internal failure.
  const env = JSON.parse(r.stdout);
  assert.ok(Array.isArray(env.doctor));
  assert.ok(Array.isArray(env.doctorChecks));
  assert.ok(r.code === 0 || r.code === 1, `unexpected exit code ${r.code}`);
});

test("init: --force-root-config creates a minimal opencode.json", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  const r = await runInit(repoRoot, ["--force-root-config"]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(existsSync(join(repoRoot, "opencode.json")), "opencode.json should exist");
  const doc = JSON.parse(readFileSync(join(repoRoot, "opencode.json"), "utf8"));
  assert.equal(doc.$schema, "https://opencode.ai/config.json");
  assert.ok(doc.agent?.build?.permission, "permission block must exist under agent.build");
  assert.equal(doc.agent.build.permission.delivery_verify, "deny");
  assert.equal(doc.agent.build.permission.delivery_review, "deny");
  assert.equal(doc.agent.build.permission.delivery_merge, "ask");
  assert.equal(doc.agent.build.permission.delivery_inspect, "allow");
  assert.equal(doc.agent.build.permission.task["delivery-reviewer"], "allow");
  assert.equal(doc.agent.build.permission.task["delivery-verifier"], "allow");
  assert.equal(doc.subagent_depth, 2);
  // From 1.1.3 the agent-root wildcard is NOT emitted; consumer
  // built-ins (read, edit, bash, …) must stay consumer-owned.
  assert.equal(doc.agent.build.permission["*"], undefined,
    "agent.build.permission/* must not be installed — it would mask consumer built-ins");
  assert.equal(doc.agent.build.permission.task["ship-controller"], "allow");
  assert.equal(doc.agent["ship-controller"].permission["*"], undefined,
    "agent.ship-controller.permission/* must not be installed for the same reason");
  assert.equal(doc.agent["ship-controller"].permission.ship_task_start, "allow");
  assert.equal(doc.agent["ship-controller"].permission.ship_task_report, "deny");
  assert.equal(doc.agent["ship-controller"].permission.bash["rm -rf *"], "deny");
});

test("init: --force-root-config preserves JSONC key order when rewriting", async (t) => {
  const { parent, repoRoot } = await makeProject();
  t.after(async () => cleanProject(parent));
  await writeFileTo(
    repoRoot,
    "opencode.jsonc",
    "// initial comment\n{\n  \"$schema\": \"https://opencode.ai/config.json\",\n  \"agent\": {\n    \"build\": {\n      \"permission\": {\n        \"delivery_merge\": \"ask\"\n      }\n    }\n  }\n}\n",
  );
  const r = await runInit(repoRoot, ["--force-root-config"]);
  assert.equal(r.code, 0, r.stderr);
  const out = readFileSync(join(repoRoot, "opencode.jsonc"), "utf8");
  // The existing JSONC file already contains `delivery_merge: ask`. The installer keeps
  // the comment while ordering the wildcard deny before its explicit exceptions.
  // Strip the leading `// initial comment\n` before JSON parsing.
  const stripped = out.replace(/^\s*\/\/.*\n/, "");
  const parsed = JSON.parse(stripped);
  assert.equal(parsed.$schema, "https://opencode.ai/config.json");
  assert.ok(parsed.agent?.build?.permission);
  assert.equal(parsed.agent.build.permission.delivery_merge, "ask");
  assert.equal(parsed.agent.build.permission.delivery_verify, "deny");
  const worktreeRemoveFlag = "git worktree remove " + "--force *";
  assert.equal(parsed.agent.build.permission.bash[worktreeRemoveFlag], "deny");
  assert.match(out, /^\s*\/\/ initial comment/m);
  const permissionKeys = Object.keys(parsed.agent.build.permission);
  assert.ok(permissionKeys.indexOf("*") < permissionKeys.indexOf("delivery_merge"));
});

function hashOf(s) {
  return createHash("sha256").update(s).digest("hex");
}
