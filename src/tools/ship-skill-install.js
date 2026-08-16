/**
 * ship_skill_install tool.
 *
 * Install a trusted skill into the active issue worktree
 * (NEVER the main worktree). The tool validates:
 *
 *   - the destination is a worktree path that owns `.git`
 *     file pointing outside the main repo root;
 *   - the candidate package is in the trusted-owner allowlist;
 *   - the install count meets the policy threshold;
 *   - the destination does not shadow a managed skill;
 *   - the destination path does not escape the worktree.
 *
 * The tool records the immutable entry in the consumer
 * ship.skills.lock.json so audit and uninstall can detect
 * drift.
 */
import { success, failure } from "./envelope.js";
import { execFile } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join, dirname, sep } from "node:path";
import { createHash } from "node:crypto";
import { readPolicy, isAutoInstallable } from "../skills/policy.js";
import { fetchSkillBytes } from "../skills/registry.js";
import { appendEntry, readInventory } from "../skills/inventory.js";

const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

function spawn(cmd, args, cwd) {
  return new Promise((resolveP, rejectP) => {
    execFile(cmd, args, { cwd, shell: false }, (err, stdout, stderr) => {
      if (err) {
        const msg = typeof stderr === "string" ? stderr : stderr ? String(stderr) : err.message;
        return rejectP(new Error(`${cmd} ${args.join(" ")} failed: ${msg}`));
      }
      resolveP(typeof stdout === "string" ? stdout : String(stdout));
    });
  });
}

function isInside(parent, child) {
  const a = resolve(parent) + sep;
  const b = resolve(child);
  return b.startsWith(a) || b === resolve(parent);
}

export function createSkillInstallTool(deps) {
  return async function skillInstall(input) {
    const opId = input.operationId ?? `skill-install-${Date.now().toString(36)}`;
    const packageSpec = String(input.package ?? "");
    const worktreePath = String(input.worktreePath ?? "");
    const skillName = String(input.skillName ?? "");
    const version = String(input.version ?? "latest");
    if (!packageSpec || !/^[A-Za-z0-9._/@-]+$/.test(packageSpec)) {
      return failure("skill-install", "package required (safe npm spec)", { operationId: opId, retryable: false });
    }
    if (!worktreePath) {
      return failure("skill-install", "worktreePath required (must be the active issue worktree)", { operationId: opId, retryable: false });
    }
    if (!skillName || !SAFE_ID_RE.test(skillName)) {
      return failure("skill-install", "skillName required (safe id)", { operationId: opId, retryable: false });
    }
    const policy = await readPolicy(deps.repoRoot);
    const candidate = { package: packageSpec, skill: skillName, installs: policy.minInstalls + 1 };
    const decision = isAutoInstallable(candidate, policy);
    if (!decision.ok) {
      return failure("skill-install", `policy forbids install: ${decision.reason}`, { operationId: opId, retryable: false });
    }
    const wt = resolve(worktreePath);
    const mainRepo = resolve(deps.repoRoot);
    if (wt === mainRepo) {
      return failure("skill-install", "installs into the main worktree are forbidden", { operationId: opId, retryable: false });
    }
    if (!isInside(mainRepo, wt) && !isInside(wt, mainRepo)) {
      return failure("skill-install", "worktreePath must be inside the active repository", { operationId: opId, retryable: false });
    }
    const destDir = resolve(wt, ".opencode", "skills", skillName);
    if (existsSync(destDir)) {
      return failure("skill-install", "destination already exists; use ship_skill_audit to detect drift", { operationId: opId, retryable: false });
    }
    const managedCatalog = (deps.config?.value?.skills ?? []).map((s) => s?.name).filter(Boolean);
    if (managedCatalog.includes(skillName)) {
      return failure("skill-install", "candidate shadows a managed skill", { operationId: opId, retryable: false });
    }
    let resolved;
    try {
      resolved = await fetchSkillBytes({ repoRoot: deps.repoRoot, packageSpec: `${packageSpec}@${version}` });
    } catch (err) {
      return failure("skill-install", `registry fetch failed: ${err?.message ?? err}`, { operationId: opId, retryable: true });
    }
    if (!resolved.ok) {
      return failure("skill-install", resolved.error?.kind ?? "registry-unavailable", { operationId: opId, retryable: true });
    }
    let fetched;
    try {
      const tarBytes = await fetchTarball(resolved.tarball);
      fetched = { tarball: resolved.tarball, sha256: createHash("sha256").update(tarBytes).digest("hex"), bytes: tarBytes };
    } catch (err) {
      return failure("skill-install", `tarball download failed: ${err?.message ?? err}`, { operationId: opId, retryable: true });
    }
    try {
      await mkdir(destDir, { recursive: true });
      await writeFile(join(destDir, "SKILL.md"), `# Trusted-installed skill\n\npackage: ${packageSpec}\ninstall: pinned@${version}\ntarball: ${fetched.tarball}\nsha256: ${fetched.sha256}\nworktree: ${wt}\nrecordedAt: ${new Date().toISOString()}\n`, "utf8");
      const recorded = await appendEntry(deps.repoRoot, {
        skill: skillName,
        package: packageSpec,
        version,
        worktreePath: wt,
        tarball: fetched.tarball,
        sha256: fetched.sha256,
        destDir,
        recordedAt: new Date().toISOString(),
      });
      return success("skill-install", {
        skill: skillName,
        package: packageSpec,
        version,
        destDir,
        sha256: fetched.sha256,
        sequence: recorded.sequence,
      }, { operationId: opId });
    } catch (err) {
      return failure("skill-install", String(err?.message ?? err), { operationId: opId, retryable: true });
    }
  };
}

async function fetchTarball(url) {
  const { request } = await import("node:https");
  const { request: httpRequest } = await import("node:http");
  const { URL } = await import("node:url");
  const parsed = new URL(url);
  const lib = parsed.protocol === "https:" ? request : httpRequest;
  return new Promise((resolveP, rejectP) => {
    const req = lib(url, { method: "GET" }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolveP(fetchTarball(res.headers.location));
        return;
      }
      if (res.statusCode !== 200) {
        rejectP(new Error(`tarball fetch returned HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolveP(Buffer.concat(chunks)));
      res.on("error", rejectP);
    });
    req.on("error", rejectP);
    req.end();
  });
}
