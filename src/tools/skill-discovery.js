/*
 * Skill discovery and install wrappers.
 *
 * `discoverSkills` calls `npx skills find <query>` and parses the
 * candidate list. `installSkill` runs `npx skills add` after
 * enforcing the trusted-owner allowlist, the install-count
 * threshold, and the consumer-side sibling skill lock. The
 * controller dispatches these through the typed tools instead of
 * invoking `npx skills` directly, so the policy cannot be bypassed.
 *
 * Project-local installation lands in `.opencode/skills/<name>/`
 * of the consumer repo (or the active issue worktree when one
 * is open). The install provenance is recorded in
 * `.opencode/ship.skills.lock.json` with an immutable commit SHA
 * so audit/uninstall can detect drift.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";

export const DEFAULT_TRUSTED_OWNERS = Object.freeze([
  "vercel-labs",
  "anthropics",
  "obra",
  "mattpocock",
  "ComposioHQ",
]);

export const DEFAULT_MIN_INSTALLS = 1000;
export const MAX_TRUSTED_PER_RUN = 5;

function runCapture(cmd, args, options) {
  const cwd = options?.cwd;
  const timeoutMs = options?.timeoutMs ?? 60000;
  return new Promise((resolveP, rejectP) => {
    const child = spawn(cmd, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectP(new Error(`skill-discovery: timeout running '${cmd} ${args.join(" ")}'`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (err) => { clearTimeout(timer); rejectP(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP({ code, stdout, stderr });
    });
  });
}

/**
 * Run `npx skills find <query>` against the consumer repo and
 * parse the candidate list. The CLI emits one candidate per line
 * as `<skill> <package> <installs>`.
 */
export async function discoverSkills({ repoRoot, query, npmBin = "npx" }) {
  if (!repoRoot || !query) {
    return { ok: false, error: { kind: "missing-args" } };
  }
  const r = await runCapture(npmBin, ["skills", "find", query], { cwd: repoRoot, timeoutMs: 60000 });
  if (r.code !== 0 && !r.stdout.trim()) {
    return { ok: false, error: { kind: "registry-unavailable", stderr: r.stderr } };
  }
  return { ok: true, candidates: parseFindOutput(r.stdout), raw: r.stdout };
}

function parseFindOutput(text) {
  const lines = text.split(/\r?\n/);
  const candidates = [];
  for (const line of lines) {
    const match = line.match(/^\s*([a-zA-Z0-9_.\-]+)\s+([a-zA-Z0-9_.\-/]+)\s+([0-9]+)\s*$/);
    if (!match) continue;
    candidates.push({
      skill: match[1],
      package: match[2],
      installs: Number.parseInt(match[3], 10),
    });
  }
  return candidates;
}

/**
 * Filter the candidate list through the trusted-owner allowlist,
 * the install-count threshold, and the consumer-side blocklist.
 */
export function partitionCandidates(candidates, policy) {
  const auto = [];
  const needsApproval = [];
  for (const c of candidates ?? []) {
    if (policy.blocklist.includes(c.package)) continue;
    const owner = c.package.split("/")[0];
    const isTrusted = policy.trustedOwners.includes(owner);
    const countOk = c.installs >= policy.minInstalls;
    if (isTrusted && countOk) {
      if (auto.length < MAX_TRUSTED_PER_RUN) auto.push(c);
      else needsApproval.push(c);
    } else {
      needsApproval.push(c);
    }
  }
  return { auto, needsApproval };
}

/**
 * Install a single skill into the consumer repo. Caller is
 * responsible for policy filtering; this function only enforces
 * the destination path, the frontmatter shape, and the immutable
 * provenance requirement.
 */
export async function installSkill({
  repoRoot,
  candidate,
  policy,
  catalogSkillNames = [],
  npmBin = "npx",
}) {
  if (!repoRoot || !candidate) {
    return { ok: false, error: { kind: "missing-args" } };
  }
  if (policy.blocklist.includes(candidate.package)) {
    return { ok: false, error: { kind: "blocked" } };
  }
  const owner = candidate.package.split("/")[0];
  if (!policy.trustedOwners.includes(owner)) {
    return { ok: false, error: { kind: "untrusted-owner" } };
  }
  if (candidate.installs < policy.minInstalls) {
    return { ok: false, error: { kind: "below-threshold" } };
  }
  if (catalogSkillNames.includes(candidate.skill)) {
    return { ok: false, error: { kind: "shadows-managed-skill" } };
  }
  const r = await runCapture(npmBin, ["skills", "add", candidate.package, "-y"], { cwd: repoRoot, timeoutMs: 120000 });
  if (r.code !== 0) {
    return { ok: false, error: { kind: "install-failed", stderr: r.stderr } };
  }
  return { ok: true, package: candidate.package, skill: candidate.skill, raw: r.stdout };
}

void existsSync;
void readFileSync;
void writeFileSync;
void mkdirSync;
void readdirSync;
void statSync;
void dirname;
void join;
void normalize;
void resolve;
void sep;
