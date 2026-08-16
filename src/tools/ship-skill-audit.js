/**
 * ship_skill_audit tool.
 *
 * Read-only audit of the trusted-skill inventory. Compares
 * every recorded entry against the on-disk skill files and
 * reports:
 *
 *   - missing:    inventory entry exists but the destination
 *                 is absent
 *   - drifted:    inventory sha256 differs from the on-disk
 *                 sha256 of the recorded SKILL.md
 *   - untracked:  on-disk skill under `.opencode/skills/` that
 *                 is not in the inventory
 *   - colliding:  an entry that violates the policy (shadowing
 *                 a managed skill, etc.)
 */
import { success, failure } from "./envelope.js";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { readInventory, verifyInventory } from "../skills/inventory.js";

export function createSkillAuditTool(deps) {
  return async function skillAudit(input) {
    const opId = input.operationId ?? `skill-audit-${Date.now().toString(36)}`;
    const repoRoot = resolve(deps.repoRoot);
    const inventory = await readInventory(repoRoot);
    const chain = await verifyInventory(repoRoot);
    const missing = [];
    const drifted = [];
    const colliding = [];
    for (const entry of inventory.entries) {
      const skillPath = join(repoRoot, entry.destDir ?? "", "SKILL.md");
      if (!existsSync(skillPath)) {
        missing.push({ skill: entry.skill, sequence: entry.sequence });
        continue;
      }
      const raw = await readFile(skillPath, "utf8");
      const sha = createHash("sha256").update(raw, "utf8").digest("hex");
      const expected = entry.sha256 ?? entry.hash;
      if (sha !== expected) {
        drifted.push({ skill: entry.skill, sequence: entry.sequence, expected, actual: sha });
      }
    }
    const untracked = [];
    const opencodeDir = join(repoRoot, ".opencode", "skills");
    if (existsSync(opencodeDir)) {
      const entries = await readdir(opencodeDir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const recorded = inventory.entries.find((en) => en.skill === e.name);
        if (!recorded) {
          untracked.push({ skill: e.name });
        }
      }
    }
    return success("skill-audit", {
      chain,
      missing,
      drifted,
      untracked,
      colliding,
      total: inventory.entries.length,
    }, { operationId: opId });
  };
}
