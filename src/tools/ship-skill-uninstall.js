/**
 * ship_skill_uninstall tool.
 *
 * Remove a trusted-skill entry. The tool only removes files
 * whose recorded sha256 still matches the inventory. If the
 * on-disk file has drifted, the tool refuses to remove it
 * (the user must delete via git / move the entry to a
 * conflict log).
 */
import { success, failure } from "./envelope.js";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { readInventory, writeInventory } from "../skills/inventory.js";

const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function createSkillUninstallTool(deps) {
  return async function skillUninstall(input) {
    const opId = input.operationId ?? `skill-uninstall-${Date.now().toString(36)}`;
    const skillName = String(input.skill ?? "");
    if (!skillName || !SAFE_ID_RE.test(skillName)) {
      return failure("skill-uninstall", "skill required (safe id)", { operationId: opId, retryable: false });
    }
    const repoRoot = resolve(deps.repoRoot);
    const inventory = await readInventory(repoRoot);
    const idx = inventory.entries.findIndex((e) => e.skill === skillName);
    if (idx === -1) {
      return failure("skill-uninstall", "skill not in inventory", { operationId: opId, retryable: false });
    }
    const entry = inventory.entries[idx];
    const target = join(repoRoot, entry.destDir ?? "", "SKILL.md");
    if (existsSync(target)) {
      const raw = await readFile(target, "utf8");
      const sha = createHash("sha256").update(raw, "utf8").digest("hex");
      if (sha !== (entry.sha256 ?? entry.hash)) {
        return failure("skill-uninstall", "skill file drifted; refusing to remove. Resolve manually.", { operationId: opId, retryable: false });
      }
      await unlink(target).catch(() => null);
    }
    inventory.entries.splice(idx, 1);
    await writeInventory(repoRoot, inventory);
    return success("skill-uninstall", { skill: skillName, removed: true }, { operationId: opId });
  };
}
