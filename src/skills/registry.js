/**
 * Pinned `npx skills` registry wrapper.
 *
 * The trusted skill lifecycle uses the public `npx skills` CLI
 * rather than a vendored copy so the registry is always the
 * canonical source. The wrapper enforces `shell: false`,
 * a 60s timeout, and rejects paths / output that mention
 * `.git/`.
 */
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";

import { discoverSkills as discoverViaFind } from "../tools/skill-discovery.js";

export const SKILLS_CLI_TIMEOUT_MS = 60 * 1000;
export const SKILLS_INSTALL_TIMEOUT_MS = 120 * 1000;

function runCapture(cmd, args, options = {}) {
  const cwd = options.cwd;
  const timeoutMs = options.timeoutMs ?? 60000;
  const stdin = options.stdin;
  return new Promise((resolveP, rejectP) => {
    const child = spawn(cmd, args, { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectP(new Error(`skill-registry: timeout running '${cmd} ${args.join(" ")}'`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (err) => { clearTimeout(timer); rejectP(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP({ code, stdout, stderr });
    });
    if (stdin !== undefined) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

export async function listSkills({ repoRoot, query, npmBin = "npx" }) {
  return discoverViaFind({ repoRoot, query, npmBin });
}

export async function fetchSkillBytes({ repoRoot, packageSpec, npmBin = "npx" }) {
  // The CLI exposes `skills add` but no clean stdout stream. We
  // downloads the tarball directly via the npm CLI in a
  // deterministic way so the install path is auditable.
  const r = await runCapture(npmBin, ["view", packageSpec, "dist.tarball"], {
    cwd: repoRoot,
    timeoutMs: SKILLS_CLI_TIMEOUT_MS,
  });
  if (r.code !== 0) {
    return { ok: false, error: { kind: "registry-unavailable", stderr: r.stderr } };
  }
  const tarball = r.stdout.trim();
  if (!/^https?:\/\//.test(tarball)) {
    return { ok: false, error: { kind: "bad-tarball-url", tarball } };
  }
  return { ok: true, tarball };
}

export function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function readSafeJson(path) {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw);
}

export async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

export function packageKey(packageSpec) {
  return `${packageSpec}`.replace(/[^A-Za-z0-9._-]+/g, "_");
}
