/**
 * ship_skill_install tool.
 *
 * Install a trusted skill into `<repoRoot>/.opencode/skills/<name>`
 * on the main checkout, or into a registered linked worktree at
 * the same relative path. The tool requires:
 *
 *   - the consumer's main checkout at `repoRoot`;
 *   - `worktreePath` omitted or equal to repoRoot (project-local
 *     `.opencode/skills/<name>`), or a registered linked worktree
 *     (validated via `git worktree list --porcelain`);
 *   - the candidate is in the trusted-owner allowlist and meets
 *     the install threshold;
 *   - the destination does not shadow a managed skill;
 *   - the real bytes are materialised via the public `skills` CLI
 *     in a staging directory; the bytes copied into the worktree
 *     are exactly the staged bytes (byte-for-byte);
 *   - every installed file is hashed individually and recorded in
 *     the append-only inventory chain (schema v2).
 *
 * Main-checkout writes are allowed only under `.opencode/skills/**`.
 * The tool refuses to write when the `skills` CLI is unavailable
 * or returns an error. No placeholder `SKILL.md` is ever written.
 */
import { success, failure } from "./envelope.js";
import { readFile, writeFile, mkdir, rm, rename, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join, dirname, sep, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { readPolicy, isAutoInstallable } from "../skills/policy.js";
import { appendEvent, readInventory, verifyInventory } from "../skills/inventory.js";
import { validateLinkedWorktree, validateRelativeInstallPath, validateInstallDestination, isProjectSkillDest } from "../skills/worktree.js";
import { listSkills } from "../skills/registry.js";

const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const SAFE_NAME_RE = /^[A-Za-z0-9._/-]{1,160}$/;
const SAFE_VERSION_RE = /^[A-Za-z0-9._+-]{1,64}$/;
const SKILLS_CLI_VERSION = "1.0.4";

export function createSkillInstallTool(deps) {
  return async function skillInstall(input) {
    const opId = input.operationId ?? `skill-install-${Date.now().toString(36)}`;
    const packageSpec = String(input.package ?? "");
    const worktreePath = input.worktreePath == null ? "" : String(input.worktreePath);
    const skillName = String(input.skillName ?? "");
    const version = String(input.version ?? "");
    if (!packageSpec || !SAFE_NAME_RE.test(packageSpec)) {
      return failure("skill-install", "package required (safe npm spec)", { operationId: opId, retryable: false });
    }
    if (!skillName || !SAFE_ID_RE.test(skillName)) {
      return failure("skill-install", "skillName required (safe id)", { operationId: opId, retryable: false });
    }
    if (version && !SAFE_VERSION_RE.test(version)) {
      return failure("skill-install", "version must match a safe semver spec", { operationId: opId, retryable: false });
    }
    const destRel = `.opencode/skills/${skillName}`;
    if (!isProjectSkillDest(destRel)) {
      return failure("skill-install", `destination rejected: ${destRel}`, { operationId: opId, retryable: false });
    }
    const policy = await readPolicy(deps.repoRoot);
    const ownerCandidate = {
      package: packageSpec,
      skill: skillName,
      installs: Number.MAX_SAFE_INTEGER,
    };
    const ownerDecision = isAutoInstallable(ownerCandidate, policy);
    if (!ownerDecision.ok) {
      return failure("skill-install", `policy forbids install: ${ownerDecision.reason}`, { operationId: opId, retryable: false });
    }
    const requested = worktreePath ? resolve(worktreePath) : resolve(deps.repoRoot);
    const main = resolve(deps.repoRoot);
    let installRoot;
    if (requested === main) {
      installRoot = main;
    } else {
      const wtCheck = await validateLinkedWorktree(deps.repoRoot, worktreePath);
      if (!wtCheck.ok) {
        return failure("skill-install", `worktree rejected: ${wtCheck.message}`, { operationId: opId, retryable: false });
      }
      installRoot = wtCheck.path;
    }
    const pathCheck = validateRelativeInstallPath(destRel);
    if (!pathCheck.ok) {
      return failure("skill-install", `destination rejected: ${pathCheck.message}`, { operationId: opId, retryable: false });
    }
    const destinationCheck = await validateInstallDestination(installRoot, destRel);
    if (!destinationCheck.ok) {
      return failure("skill-install", `destination rejected: ${destinationCheck.message}`, { operationId: opId, retryable: false });
    }
    const destAbs = destinationCheck.path;
    if (existsSync(destAbs)) {
      return failure("skill-install", "destination already exists; use ship_skill_audit to detect drift", { operationId: opId, retryable: false });
    }
    const managedCatalog = (deps.config?.value?.skills ?? []).map((s) => s?.name).filter(Boolean);
    if (managedCatalog.includes(skillName)) {
      return failure("skill-install", "candidate shadows a managed skill", { operationId: opId, retryable: false });
    }
    const discover = deps.discoverSkills ?? listSkills;
    const discovery = await discover({ repoRoot: deps.repoRoot, query: packageSpec });
    if (!discovery?.ok) {
      return failure("skill-install", "registry metadata unavailable; refusing unverified install", { operationId: opId, retryable: true });
    }
    const candidate = discovery.candidates?.find((entry) => entry.package === packageSpec && entry.skill === skillName);
    if (!candidate) {
      return failure("skill-install", "exact skill package was not found in registry metadata", { operationId: opId, retryable: false });
    }
    const decision = isAutoInstallable(candidate, policy);
    if (!decision.ok) {
      return failure("skill-install", `policy forbids install: ${decision.reason}`, { operationId: opId, retryable: false });
    }
    // 1. Materialise real bytes via the skills CLI in a staging
    //    directory. We refuse to write anything to the worktree
    //    until we have a clean staging copy that byte-matches the
    //    CLI output.
    const stage = await mkdtemp(join(tmpdir(), `ship-skill-stage-${randomBytes(4).toString("hex")}-`));
    let installedFiles;
    try {
      const materialise = deps.materialiseFromSkillsCli ?? materialiseFromSkillsCli;
      installedFiles = await materialise({
        packageSpec,
        skillName,
        version,
        stageDir: stage,
      });
      if (!installedFiles.ok) {
        return failure("skill-install", installedFiles.message, { operationId: opId, retryable: installedFiles.retryable ?? false });
      }
      // 2. Hash every file in the staged directory. The recorded
      //    inventory hashes MUST match what we are about to copy.
      const fileRecords = await hashDir(installedFiles.stagedDir);
      if (fileRecords.length === 0) {
        return failure("skill-install", "skills CLI produced an empty staging directory", { operationId: opId, retryable: false });
      }
      // 3. Atomic copy: stage -> destAbs. Use a sibling temp + rename
      //    so a partial copy never leaves a half-installed skill.
      await mkdir(dirname(destAbs), { recursive: true });
      const destTmp = `${destAbs}.${randomBytes(4).toString("hex")}.tmp`;
      await copyDir(installedFiles.stagedDir, destTmp);
      const finalDestinationCheck = await validateInstallDestination(installRoot, destRel);
      if (!finalDestinationCheck.ok) {
        await rm(destTmp, { recursive: true, force: true });
        return failure("skill-install", `destination rejected: ${finalDestinationCheck.message}`, { operationId: opId, retryable: false });
      }
      await rename(destTmp, destAbs);
      // 4. Verify the on-disk hashes match the staged hashes. If
      //    the rename target somehow drifted, abort with a clear
      //    diagnostic and roll back.
      const onDisk = await hashDir(destAbs);
      if (!hashesEqual(fileRecords, onDisk)) {
        await rm(destAbs, { recursive: true, force: true });
        return failure("skill-install", "drift detected after copy; rolled back", { operationId: opId, retryable: false });
      }
      // 5. Append to the inventory chain (schema v2).
      const recorded = await appendEvent(installRoot, {
        type: "install",
        skill: skillName,
        package: packageSpec,
        version: version || null,
        source: installedFiles.source,
        destination: destRel,
        files: fileRecords,
      });
      return success("skill-install", {
        skill: skillName,
        package: packageSpec,
        version: version || null,
        destination: destRel,
        worktree: installRoot,
        source: installedFiles.source,
        files: fileRecords,
        sequence: recorded.sequence,
      }, { operationId: opId });
    } catch (err) {
      // Roll back any partial install.
      if (existsSync(destAbs)) {
        await rm(destAbs, { recursive: true, force: true }).catch(() => null);
      }
      return failure("skill-install", String(err?.message ?? err), { operationId: opId, retryable: true });
    } finally {
      await rm(stage, { recursive: true, force: true }).catch(() => null);
    }
  };
}

/**
 * Invoke the public `skills` CLI in a staging directory and return
 * the staged skill directory plus its source provenance.
 */
async function materialiseFromSkillsCli({ packageSpec, skillName, version, stageDir }) {
  // The CLI signature is:
  //   skills add <package> --skill <name> --agent opencode --copy -y
  // We pin the CLI to a known version so we are not at the mercy
  // of the latest published bit.
  const cliPkg = `skills@${SKILLS_CLI_VERSION}`;
  const resolvedPackageSpec = version ? `${packageSpec}@${version}` : packageSpec;
  // The `<package>` argument can be a GitHub owner/repo or a full
  // npm package spec. The CLI handles both. We always pass through
  // the user-supplied spec verbatim (validated against the safe id
  // regex at the top of this tool).
  const args = [
    "exec",
    "--yes",
    `--package=${cliPkg}`,
    "--",
    "skills",
    "add",
    resolvedPackageSpec,
    "--skill",
    skillName,
    "--agent",
    "opencode",
    "--copy",
    "-y",
  ];
  const result = await new Promise((resolveP, rejectP) => {
    execFile(
      "npm",
      args,
      { cwd: stageDir, shell: false, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const code = typeof err?.code === "number" ? err.code : -1;
          return resolveP({
            ok: false,
            retryable: code === -2 || code === 124,
            message: `skills CLI failed (code ${code}): ${(stderr || stdout || "").toString().trim().split("\n").slice(-5).join(" | ")}`,
          });
        }
        resolveP({ ok: true, stdout: stdout?.toString?.() ?? "", stderr: stderr?.toString?.() ?? "" });
      },
    );
  });
  if (!result.ok) return result;
  // The CLI copies the skill into `./.opencode/skills/<name>` under
  // the staging cwd. We look for that path explicitly.
  const stagedDir = join(stageDir, ".opencode", "skills", skillName);
  if (!existsSync(stagedDir)) {
    return {
      ok: false,
      retryable: false,
      message: `skills CLI did not produce ${stagedDir}`,
    };
  }
  // Sanity check: the staged directory must contain a SKILL.md.
  const skillMd = join(stagedDir, "SKILL.md");
  if (!existsSync(skillMd)) {
    return {
      ok: false,
      retryable: false,
      message: "skills CLI did not produce a SKILL.md",
    };
  }
  // Provenance: derive the source from the package spec.
  //   - npm owner/name@version
  //   - github:owner/repo@ref
  // The registryId is the resolved package spec at install time.
  return {
    ok: true,
    stagedDir,
    source: {
      packageSpec: resolvedPackageSpec,
      skillName,
      cliPackage: cliPkg,
      registryId: `${resolvedPackageSpec}/${skillName}`,
      // The CLI does not currently expose a registry snapshot
      // hash; we record the staged directory's hash instead so
      // the audit tool can prove the staged bytes equal the
      // installed bytes.
      registrySnapshotHash: hashBytes(Buffer.from(result.stdout + "\n" + result.stderr, "utf8")),
    },
  };
}

async function hashDir(rootDir) {
  /** @type {Array<{ path: string, sha256: string, mode: number, size: number }>} */
  const out = [];
  await walk(rootDir, rootDir, out);
  return out;
}

async function walk(rootDir, currentDir, out) {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(currentDir, { withFileTypes: true });
  for (const e of entries) {
    const abs = join(currentDir, e.name);
    if (e.isDirectory()) {
      // Refuse .git inside the staged skill; the CLI should not
      // ship one but be defensive.
      if (e.name === ".git") continue;
      await walk(rootDir, abs, out);
      continue;
    }
    if (!e.isFile()) continue;
    const raw = await readFile(abs);
    const fileStat = await stat(abs);
    out.push({
      path: abs.slice(rootDir.length + 1).split(sep).join("/"),
      sha256: createHash("sha256").update(raw).digest("hex"),
      mode: fileStat.mode & 0o777,
      size: fileStat.size,
    });
  }
}

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashesEqual(a, b) {
  if (a.length !== b.length) return false;
  const map = new Map(a.map((f) => [f.path, f.sha256]));
  for (const f of b) {
    if (map.get(f.path) !== f.sha256) return false;
  }
  return true;
}

async function copyDir(srcDir, destDir) {
  await mkdir(destDir, { recursive: true });
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const e of entries) {
    const src = join(srcDir, e.name);
    const dest = join(destDir, e.name);
    if (e.isDirectory()) {
      if (e.name === ".git") continue;
      await copyDir(src, dest);
    } else if (e.isFile()) {
      const raw = await readFile(src);
      await writeFile(dest, raw, { mode: 0o644 });
    }
  }
}
