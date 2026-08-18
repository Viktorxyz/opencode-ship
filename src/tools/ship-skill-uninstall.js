/**
 * ship_skill_uninstall tool.
 *
 * Remove a trusted-skill entry. The tool:
 *
 *   1. Re-verifies the inventory chain. A broken chain refuses to
 *      uninstall (the operator must repair or reset explicitly).
 *   2. Finds the latest active install event for the skill.
 *   3. Verifies every recorded file is unchanged on disk. Drifted,
 *      missing, extra, or symlinked content causes refusal.
 *   4. Deletes only the recorded files (and empty parent dirs).
 *   5. Appends an uninstall tombstone to the inventory. The
 *      install event stays in the chain; the tombstone makes it
 *      inactive.
 *
 * Calling uninstall twice is an idempotent no-op (the second call
 * finds no active install).
 */
import { success, failure } from "./envelope.js";
import { readFile, unlink, rm, readdir, lstat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { readInventory, verifyInventory, findActiveInstall, appendEvent } from "../skills/inventory.js";
import { validateLinkedWorktree, validateInstallDestination } from "../skills/worktree.js";

const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function createSkillUninstallTool(deps) {
  return async function skillUninstall(input) {
    const opId = input.operationId ?? `skill-uninstall-${Date.now().toString(36)}`;
    const skillName = String(input.skill ?? "");
    if (!skillName || !SAFE_ID_RE.test(skillName)) {
      return failure("skill-uninstall", "skill required (safe id)", { operationId: opId, retryable: false });
    }
    const repoRoot = resolve(deps.repoRoot);
    const worktree = await validateLinkedWorktree(repoRoot, String(input.worktreePath ?? ""));
    if (!worktree.ok) {
      return failure("skill-uninstall", `worktree rejected: ${worktree.message}`, { operationId: opId, retryable: false });
    }
    const inventoryRoot = worktree.path;
    const chain = await verifyInventory(inventoryRoot);
    if (!chain.ok) {
      return failure("skill-uninstall", `inventory chain invalid: ${chain.reason}`, { operationId: opId, retryable: false });
    }
    const found = await findActiveInstall(inventoryRoot, skillName);
    if (!found.ok) {
      return failure("skill-uninstall", `inventory lookup failed: ${found.reason}`, { operationId: opId, retryable: false });
    }
    if (!found.install) {
      return failure("skill-uninstall", "skill not in active inventory", { operationId: opId, retryable: false });
    }
    const installRoot = inventoryRoot;
    const destination = await validateInstallDestination(installRoot, found.install.destination);
    if (!destination.ok) {
      return failure("skill-uninstall", `destination rejected: ${destination.message}`, { operationId: opId, retryable: false });
    }
    const skillDir = destination.path;
    const actualFiles = await listInstalledFiles(skillDir);
    if (!actualFiles.ok) {
      return failure("skill-uninstall", actualFiles.message, { operationId: opId, retryable: false });
    }
    const recordedPaths = new Set((found.install.files ?? []).map((file) => file.path));
    const extras = actualFiles.paths.filter((path) => !recordedPaths.has(path));
    if (extras.length > 0) {
      return failure("skill-uninstall", `untracked files present: ${extras.join(", ")}`, { operationId: opId, retryable: false });
    }
    // Verify every recorded file is unchanged.
    for (const f of found.install.files ?? []) {
      const fileCheck = await validateInstallDestination(installRoot, `${found.install.destination}/${f.path}`);
      if (!fileCheck.ok) {
        return failure("skill-uninstall", `recorded file rejected: ${fileCheck.message}`, { operationId: opId, retryable: false });
      }
      const filePath = fileCheck.path;
      if (!existsSync(filePath)) {
        return failure("skill-uninstall", `recorded file missing: ${f.path}`, { operationId: opId, retryable: false });
      }
      const raw = await readFile(filePath);
      const sha = createHash("sha256").update(raw).digest("hex");
      if (sha !== f.sha256) {
        return failure("skill-uninstall", `recorded file drifted: ${f.path}`, { operationId: opId, retryable: false });
      }
    }
    // Delete only the recorded files. Empty parent directories are
    // removed recursively only if no untracked content remains.
    for (const f of found.install.files ?? []) {
      const filePath = join(skillDir, ...f.path.split("/"));
      await unlink(filePath).catch(() => null);
    }
    // Remove the now-empty skill directory after proving the tree
    // contained no untracked or symlinked entries.
    if (existsSync(skillDir)) {
      await rm(skillDir, { recursive: true, force: true });
    }
    // Append the uninstall tombstone. The install event stays in
    // the chain; the tombstone flips it to inactive.
    const recorded = await appendEvent(inventoryRoot, {
      type: "uninstall",
      skill: skillName,
      installHash: found.install.hash,
      package: found.install.package,
      destination: found.install.destination,
    });
    return success("skill-uninstall", {
      skill: skillName,
      removed: true,
      installHash: found.install.hash,
      tombstoneSequence: recorded.sequence,
    }, { operationId: opId });
  };
}

async function listInstalledFiles(root) {
  if (!existsSync(root)) return { ok: true, paths: [] };
  const paths = [];
  const walk = async (dir, prefix = "") => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(dir, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) return { ok: false, message: `symlinked content present: ${relative}` };
      if (info.isDirectory()) {
        const nested = await walk(absolute, relative);
        if (!nested.ok) return nested;
      } else if (info.isFile()) {
        paths.push(relative);
      } else {
        return { ok: false, message: `unsupported filesystem entry: ${relative}` };
      }
    }
    return { ok: true };
  };
  const result = await walk(root);
  return result.ok ? { ok: true, paths } : result;
}
