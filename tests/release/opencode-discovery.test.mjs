/*
 * OpenCode live-server discovery smoke.
 *
 * The in-process plugin-load test asserts the plugin contract at
 * the bundle boundary. This test asserts the same contract at the
 * OpenCode runtime boundary by booting a real `opencode serve`
 * instance, polling `/global/health`, reading
 * `/experimental/tool/ids`, and comparing the result against the
 * canonical 24-tool set in `tests/plugin/expected-tools.mjs`.
 *
 * The test is gated by the presence of the `opencode` CLI on
 * PATH (or the local user install under `$HOME/.opencode/bin`).
 * On machines without the CLI, the test is skipped so the suite
 * still runs cleanly in environments that only have the bundled
 * plugin. CI always installs the CLI through the workflow job.
 *
 * The test is fully deterministic:
 *   - the opencode data directory is bound to a fresh tmpdir so
 *     a stale state from a previous run cannot leak in;
 *   - the HOME is overridden so a developer-side `~/.config/opencode`
 *     does not influence the test;
 *   - the server is started on a high, low-collision port; the
 *     health endpoint is polled with a bounded timeout;
 *   - the server is terminated with SIGTERM, then SIGKILL after
 *     a deadline so the test never hangs on a stuck process.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  EXPECTED_OPENCODE_SHIP_TOOL_IDS,
  OPENCODE_SHIP_TOOL_COUNT,
} from "../plugin/expected-tools.mjs";

const PKG_ROOT = process.cwd();

function resolveOpencodeBinary() {
  // Prefer the well-known user install location; fall back to PATH.
  const local = join(homedir(), ".opencode", "bin", "opencode");
  if (existsSync(local)) return local;
  const probe = spawnSync("sh", ["-c", "command -v opencode"], { encoding: "utf8" });
  if (probe.status === 0) {
    const found = probe.stdout.trim();
    if (found) return found;
  }
  return null;
}

async function startOpencode({ binary, port, cwd, homeDir, logPath }) {
  // The server prints "opencode server listening on http://..." to
  // stderr (or stdout) once it has bound the port. We capture both
  // so the readiness check can confirm the bind even if the logger
  // changes the destination.
  const proc = spawn(binary, [
    "serve",
    "--port", String(port),
    "--hostname", "127.0.0.1",
    "--log-level", "WARN",
    "--print-logs",
  ], {
    cwd,
    env: {
      ...process.env,
      HOME: homeDir,
      XDG_CONFIG_HOME: join(homeDir, ".config"),
      XDG_DATA_HOME: join(homeDir, ".local", "share"),
      OPENCODE_SERVER_PASSWORD: "",
      // The CLI picks up additional plugins from OPENCODE_PLUGIN or
      // global config; isolate both so the test is reproducible.
      OPENCODE_DISABLE_GLOBAL_CONFIG: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = { stdout: "", stderr: "" };
  proc.stdout.on("data", (chunk) => { out.stdout += chunk.toString("utf8"); });
  proc.stderr.on("data", (chunk) => { out.stderr += chunk.toString("utf8"); });
  if (logPath) {
    const { writeFile: writeFileCb } = await import("node:fs/promises");
    const { createWriteStream } = await import("node:fs");
    const stream = createWriteStream(logPath, { flags: "w" });
    proc.stdout.pipe(stream);
    proc.stderr.pipe(stream);
    void writeFileCb;
  }
  return { proc, out };
}

async function pollReady(port, { timeoutMs = 60000, intervalMs = 500 } = {}) {
  // OpenCode's `/global/health` returns `healthy:true` very early
  // (right after the bind succeeds) but the plugin/tool layer is
  // only populated once the per-project instance bootstraps and
  // loads `opencode.json`. The reliable readiness signal is the
  // tool-id endpoint returning a JSON array of expected size.
  //
  // We therefore poll `/experimental/tool/ids` until it either
  // returns a non-empty array or the deadline elapses. The
  // 60-second budget covers cold-start LSP/formatter init in CI.
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/experimental/tool/ids`, { method: "GET" });
      if (r.ok) {
        const body = await r.json();
        if (Array.isArray(body) && body.length > 0) {
          return body;
        }
        lastErr = new Error(`tool/ids returned ${JSON.stringify(body).slice(0, 80)}`);
      } else {
        lastErr = new Error(`status ${r.status}`);
      }
    } catch (e) {
      lastErr = e;
    }
    await delay(intervalMs);
  }
  throw new Error(`opencode not ready after ${timeoutMs}ms: ${lastErr?.message ?? lastErr}`);
}

async function fetchToolIds(port) {
  const r = await fetch(`http://127.0.0.1:${port}/experimental/tool/ids`, { method: "GET" });
  assert.equal(r.ok, true, `/experimental/tool/ids must respond 2xx (got ${r.status})`);
  const body = await r.json();
  assert.ok(Array.isArray(body), "/experimental/tool/ids must return a JSON array");
  return body;
}

async function stopServer(proc, { deadlineMs = 5000 } = {}) {
  if (!proc || proc.exitCode !== null) return;
  proc.kill("SIGTERM");
  const start = Date.now();
  while (proc.exitCode === null && Date.now() - start < deadlineMs) {
    await delay(100);
  }
  if (proc.exitCode === null) {
    proc.kill("SIGKILL");
  }
}

function pickPort() {
  // Pick a high port unlikely to conflict with developer tooling.
  // The number is bounded so a CI runner never collides on a
  // well-known port.
  return 14100 + Math.floor(Math.random() * 200);
}

async function setupFixture({ pluginPath, profile }) {
  const root = await mkdtemp(join(tmpdir(), "opencode-ship-oc-discovery-"));
  // The plugin must live inside the project tree for opencode.json
  // to reference it via a relative path.
  const pluginDir = join(root, ".opencode", "plugins");
  await mkdir(pluginDir, { recursive: true });
  // Use a symlink so the fixture stays small and the actual plugin
  // bytes are the same ones that ship in the npm tarball.
  await symlink(pluginPath, join(pluginDir, "opencode-ship.js"));
  const config = {
    $schema: "https://opencode.ai/config.json",
    plugin: ["./.opencode/plugins/opencode-ship.js"],
  };
  if (profile === "engineering") {
    // The engineering profile does not require any extra plugin
    // settings for the discovery smoke; the Plan Mode block lives
    // under the consumer's `agent.plan.permission` and is not
    // exercised by `/experimental/tool/ids`. Recording the
    // engineering branch in the fixture keeps the test symmetric
    // with the S3 acceptance matrix even when the assertion only
    // inspects the tool set.
    config.$schema = "https://opencode.ai/config.json";
  }
  await writeFile(join(root, "opencode.json"), JSON.stringify(config, null, 2) + "\n", "utf8");
  // Initialise a git repo so opencode's project layout matches the
  // production consumer.
  spawnSync("git", ["init", "-q", "--initial-branch", "main"], { cwd: root, env: process.env });
  spawnSync("git", ["config", "user.email", "oc-discovery@local"], { cwd: root, env: process.env });
  spawnSync("git", ["config", "user.name", "oc-discovery"], { cwd: root, env: process.env });
  await writeFile(join(root, "README.md"), "# opencode-discovery fixture\n", "utf8");
  spawnSync("git", ["add", "."], { cwd: root, env: process.env });
  spawnSync("git", ["commit", "-m", "init", "--no-gpg-sign"], { cwd: root, env: process.env });
  return root;
}

const OPENCODE_BIN = resolveOpencodeBinary();
const HAS_OPENCODE = Boolean(OPENCODE_BIN);

const PLUGIN_PATH = resolve(PKG_ROOT, "dist/plugin.js");

test("opencode-discovery: CLI is discoverable when the test runs", { skip: !HAS_OPENCODE }, () => {
  assert.ok(OPENCODE_BIN, "opencode binary must resolve to a real path");
  // The symlink + which check should both yield a path that exists.
  assert.ok(existsSync(OPENCODE_BIN));
});

for (const profile of ["core", "engineering"]) {
  test(`opencode-discovery: ${profile} profile exposes exactly the 24 opencode-ship tools`, {
    skip: !HAS_OPENCODE || !existsSync(PLUGIN_PATH),
  }, async (t) => {
    assert.ok(existsSync(PLUGIN_PATH), `dist/plugin.js must be built (${PLUGIN_PATH})`);

    const homeDir = await mkdtemp(join(tmpdir(), "opencode-ship-oc-home-"));
    const fixture = await setupFixture({ pluginPath: PLUGIN_PATH, profile });
    const logPath = join(fixture, "opencode.log");
    t.after(async () => {
      await rm(fixture, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    });

    let server = null;
    let port = pickPort();
    let ready = false;
    // Retry up to 3 times on a port collision or transient boot
    // failure.
    for (let attempt = 0; attempt < 3 && !ready; attempt += 1) {
      const started = await startOpencode({
        binary: OPENCODE_BIN,
        port,
        cwd: fixture,
        homeDir,
        logPath,
      });
      server = started.proc;
      try {
        await pollReady(port, { timeoutMs: 60000 });
        ready = true;
      } catch (e) {
        await stopServer(server, { deadlineMs: 1000 });
        server = null;
        if (attempt === 2) throw e;
        port = pickPort();
      }
    }
    t.after(async () => { if (server) await stopServer(server); });

    const tools = await fetchToolIds(port);
    // The server returns built-in + plugin tools. The 24-tool set
    // must be a subset of the exposed IDs and the count of plugin
    // tools must match exactly.
    const serverSet = new Set(tools);
    for (const id of EXPECTED_OPENCODE_SHIP_TOOL_IDS) {
      assert.ok(serverSet.has(id), `${profile}: missing plugin tool ${id}`);
    }
    // The plugin registers exactly the 24 opencode-ship tools; the
    // server may expose additional built-in tools, so we only check
    // that the opencode-ship count is present and correct.
    const pluginTools = tools.filter((id) => id.startsWith("delivery_") || id.startsWith("ship_"));
    pluginTools.sort();
    assert.deepEqual(
      pluginTools,
      [...EXPECTED_OPENCODE_SHIP_TOOL_IDS],
      `${profile}: plugin tool set must be exactly the canonical set (expected ${OPENCODE_SHIP_TOOL_COUNT}, got ${pluginTools.length})`,
    );
  });
}
