#!/usr/bin/env node
/*
 * CI smoke wrapper for the opencode-discovery job.
 *
 * Mirrors `tests/release/opencode-discovery.test.mjs` but is
 * designed for a non-interactive run: it never leaves a server
 * running, never blocks on a hung CLI, and writes a bounded
 * log file the workflow can upload as an artifact on failure.
 *
 * Usage:
 *   node scripts/run-opencode-discovery-smoke.mjs \
 *     <project-dir> <opencode-version> <profile>
 *
 * Exit codes:
 *   0  healthy + 32-tool set confirmed
 *   1  opencode CLI not on PATH
 *   2  server did not become healthy in time
 *   3  tool set did not match the canonical 32
 *   4  unexpected runtime error
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import {
  EXPECTED_OPENCODE_SHIP_TOOL_IDS,
  OPENCODE_SHIP_TOOL_COUNT,
} from "../tests/plugin/expected-tools.mjs";

function isMainEntry() {
  if (!process.argv[1]) return false;
  try {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

const projectDir = process.argv[2];
const opencodeVersion = process.argv[3] ?? "1.18.10";
const profile = process.argv[4] ?? "engineering";
const explicitBinary = process.argv[5] ?? null;

if (!projectDir) {
  console.error("run-opencode-discovery-smoke: <project-dir> argument is required");
  process.exit(2);
}

const logPath = join(tmpdir(), `opencode-discovery-${opencodeVersion}-${profile}.log`);
const port = 15100 + Math.floor(Math.random() * 200);

async function pollReady(timeoutMs = 180000) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 30000);
      try {
        const r = await fetch(`http://127.0.0.1:${port}/experimental/tool/ids`, {
          method: "GET",
          signal: ac.signal,
        });
        if (r.ok) {
          const body = await r.json();
          if (Array.isArray(body) && body.length > 0) return body;
          lastErr = new Error(`tool/ids returned ${JSON.stringify(body).slice(0, 80)}`);
        } else {
          lastErr = new Error(`status ${r.status}`);
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      lastErr = e;
    }
    await delay(500);
  }
  throw new Error(`opencode not ready after ${timeoutMs}ms: ${lastErr?.message ?? lastErr}`);
}

async function stopServer(proc, deadlineMs = 5000) {
  if (!proc || proc.exitCode !== null) return;
  proc.kill("SIGTERM");
  const start = Date.now();
  while (proc.exitCode === null && Date.now() - start < deadlineMs) {
    await delay(100);
  }
  if (proc.exitCode === null) proc.kill("SIGKILL");
}

async function main() {
  // Discover the opencode binary. The CI workflow installs
  // opencode-ai into the runner's checkout
  // (`$GITHUB_WORKSPACE/node_modules`) — NOT the consumer
  // workspace — so the canonical location is the
  // `$GITHUB_WORKSPACE/node_modules/.bin/opencode` path the
  // caller passes in. Local developer runs fall back to
  // `<projectDir>/node_modules/.bin/opencode`, then to
  // `command -v opencode` on PATH, and finally to the
  // well-known user install location (`~/.opencode/bin/opencode`)
  // for parity with `tests/release/opencode-discovery.test.mjs`.
  let bin = null;
  if (explicitBinary && existsSync(explicitBinary)) bin = explicitBinary;
  if (!bin) {
    const localInstall = join(projectDir, "node_modules", ".bin", "opencode");
    if (existsSync(localInstall)) bin = localInstall;
  }
  if (!bin) {
    const probe = spawnSync("sh", ["-c", "command -v opencode"], { encoding: "utf8" });
    if (probe.status === 0 && probe.stdout.trim()) bin = probe.stdout.trim();
  }
  if (!bin) {
    const homeBin = join(homedir(), ".opencode", "bin", "opencode");
    if (existsSync(homeBin)) bin = homeBin;
  }
  if (!bin) {
    console.error("run-opencode-discovery-smoke: opencode binary not on PATH");
    process.exit(1);
  }

  const homeDir = `${projectDir}/home`;
  await mkdir(homeDir, { recursive: true });
  const proc = spawn(bin, [
    "serve",
    "--port", String(port),
    "--hostname", "127.0.0.1",
    "--log-level", "WARN",
    "--print-logs",
  ], {
    cwd: projectDir,
    env: {
      ...process.env,
      HOME: homeDir,
      XDG_CONFIG_HOME: join(homeDir, ".config"),
      XDG_DATA_HOME: join(homeDir, ".local", "share"),
      OPENCODE_SERVER_PASSWORD: "",
      OPENCODE_DISABLE_GLOBAL_CONFIG: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks = [];
  proc.stdout.on("data", (chunk) => chunks.push(chunk.toString("utf8")));
  proc.stderr.on("data", (chunk) => chunks.push(chunk.toString("utf8")));

  let tools = null;
  try {
    tools = await pollReady();
  } catch (e) {
    await writeFile(logPath, chunks.join(""), "utf8").catch(() => null);
    await stopServer(proc);
    console.error(`run-opencode-discovery-smoke: ${e.message}`);
    console.error(`log written to ${logPath}`);
    process.exit(2);
  }

  const opencodeShipTools = tools
    .filter((id) => id.startsWith("delivery_") || id.startsWith("ship_"))
    .sort();
  await stopServer(proc);
  await writeFile(logPath, chunks.join(""), "utf8").catch(() => null);
  if (opencodeShipTools.length !== OPENCODE_SHIP_TOOL_COUNT) {
    console.error(`run-opencode-discovery-smoke: expected ${OPENCODE_SHIP_TOOL_COUNT} opencode-ship tools, got ${opencodeShipTools.length}`);
    console.error(`log written to ${logPath}`);
    process.exit(3);
  }
  for (const id of EXPECTED_OPENCODE_SHIP_TOOL_IDS) {
    if (!opencodeShipTools.includes(id)) {
      console.error(`run-opencode-discovery-smoke: missing tool ${id}`);
      console.error(`log written to ${logPath}`);
      process.exit(3);
    }
  }
  console.log(`run-opencode-discovery-smoke: opencode=${opencodeVersion} profile=${profile} tools=${opencodeShipTools.length} OK`);
  process.exit(0);
}

// Gate the side effects on the entry-point check so imports get
// a no-op, side-effect-free surface and CLI invocations run the
// real smoke. Without this guard, every `import` of this module
// would also fire `main()`, which is wrong.
if (isMainEntry()) {
  main().catch((e) => {
    console.error(`run-opencode-discovery-smoke: unexpected error: ${e?.message ?? e}`);
    process.exit(4);
  });
}
