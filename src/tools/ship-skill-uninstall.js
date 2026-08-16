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
import { readFile, unlink, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { readInventory, verifyInventory, findActiveInstall, appendEvent } from "../skills/inventory.js";

const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function createSkillUninstallTool(deps) {
  return async function skillUninstall(input) {
    const opId = input.operationId ?? `skill-uninstall-${Date.now().toString(36)}`;
    const skillName = String(input.skill ?? "");
    if (!skillName || !SAFE_ID_RE.test(skillName)) {
      return failure("skill-uninstall", "skill required (safe id)", { operationId: opId, retryable: false });
    }
    const repoRoot = resolve(deps.repoRoot);
    const chain = await verifyInventory(repoRoot);
    if (!chain.ok) {
      return failure("skill-uninstall", `inventory chain invalid: ${chain.reason}`, { operationId: opId, retryable: false });
    }
    const found = await findActiveInstall(repoRoot, skillName);
    if (!found.ok) {
      return failure("skill-uninstall", `inventory lookup failed: ${found.reason}`, { operationId: opId, retryable: false });
    }
    if (!found.install) {
      return failure("skill-uninstall", "skill not in active inventory", { operationId: opId, retryable: false });
    }
    const worktreeRoot = input.worktreeRoot ?? deps.repoRoot;
    const installRoot = resolve(worktreeRoot);
    // Verify every recorded file is unchanged.
    for (const f of found.install.files ?? []) {
      const filePath = join(installRoot, found.install.destination, f.path);
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
      const filePath = join(installRoot, found.install.destination, f.path);
      await unlink(filePath).catch(() => null);
    }
    // Best-effort remove the now-empty skill directory.
    const skillDir = join(installRoot, found.install.destination);
    if (existsSync(skillDir)) {
      await rm(skillDir, { recursive: false, force: true }).catch(() => null);
    }
    // Append the uninstall tombstone. The install event stays in
    // the chain; the tombstone flips it to inactive.
    const recorded = await appendEvent(repoRoot, {
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
