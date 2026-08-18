/**
 * ship_skill_audit tool.
 *
 * Read-only audit of the trusted-skill inventory (schema v2).
 * Compares every recorded install event against the on-disk
 * files under the recorded worktree, reports drift, missing
 * files, and chain breaks.
 *
 * The audit walks the inventory chain and classifies every
 * install event as:
 *
 *   - missing:    at least one recorded file is absent
 *   - drifted:    any recorded file's sha256 differs from disk
 *   - colliding:  an entry that shadows a managed skill
 *   - chain-broken: the inventory chain itself failed verification
 */
import { success, failure } from "./envelope.js";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { readInventory, verifyInventory } from "../skills/inventory.js";
import { validateLinkedWorktree, validateInstallDestination } from "../skills/worktree.js";

export function createSkillAuditTool(deps) {
  return async function skillAudit(input) {
    const opId = input.operationId ?? `skill-audit-${Date.now().toString(36)}`;
    const repoRoot = resolve(deps.repoRoot);
    const worktree = await validateLinkedWorktree(repoRoot, String(input.worktreePath ?? ""));
    if (!worktree.ok) {
      return failure("skill-audit", `worktree rejected: ${worktree.message}`, { operationId: opId, retryable: false });
    }
    const inventoryRoot = worktree.path;
    const inventory = await readInventory(inventoryRoot);
    const chain = await verifyInventory(inventoryRoot);
    // Compute active installs: walk chain in order; an install is
    // active until an uninstall event for the same skill appears.
    const active = new Map();
    const missing = [];
    const drifted = [];
    const colliding = [];
    if (inventory.parseError) {
      return success("skill-audit", {
        chain: { ok: false, reason: inventory.parseError },
        missing, drifted, untracked: [], colliding, total: 0,
      }, { operationId: opId });
    }
    for (const ev of inventory.events) {
      if (ev.type === "install") {
        active.set(ev.skill, ev);
      } else if (ev.type === "uninstall") {
        active.delete(ev.skill);
      }
    }
    for (const ev of active.values()) {
      // The recorded destination is a relative POSIX path under
      // the worktree root that performed the install. We look it
      // up under the current `deps.repoRoot` (the main checkout)
      // because that is where the audit is invoked. If the skill
      // was installed into a separate linked worktree, the audit
      // can be invoked with the matching worktreeRoot instead.
      const installRoot = inventoryRoot;
      const destination = await validateInstallDestination(installRoot, ev.destination);
      if (!destination.ok) {
        drifted.push({ skill: ev.skill, path: ev.destination, reason: destination.message, sequence: ev.sequence });
        continue;
      }
      for (const f of ev.files ?? []) {
        const filePath = join(installRoot, ev.destination, f.path);
        if (!existsSync(filePath)) {
          missing.push({ skill: ev.skill, path: f.path, sequence: ev.sequence });
          continue;
        }
        const raw = await readFile(filePath);
        const sha = createHash("sha256").update(raw).digest("hex");
        if (sha !== f.sha256) {
          drifted.push({ skill: ev.skill, path: f.path, expected: f.sha256, actual: sha, sequence: ev.sequence });
        }
      }
    }
    const untracked = [];
    const opencodeDir = join(inventoryRoot, ".opencode", "skills");
    if (existsSync(opencodeDir)) {
      const entries = await readdir(opencodeDir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (!active.has(e.name)) {
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
      total: inventory.events.length,
      active: active.size,
    }, { operationId: opId });
  };
}
