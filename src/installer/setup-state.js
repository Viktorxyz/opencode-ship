/**
 * Setup state evaluation.
 *
 * Two distinct predicates:
 *
 *   modelsComplete(cfg)        - all three model roles populated
 *   setupComplete(repo)        - setup dialog has been completed
 *
 * The shipped 1.1.x conflated these. The new contract is:
 *
 *   setupComplete = modelsComplete
 *     && installer-owned setup docs present
 *     && AGENTS.md contains a "Ship workflow" block
 *     && lock is current v4
 *     && setup-pending marker is absent
 *
 * The setup-ship-workflow skill drives the chat-only flow that
 * produces every one of these. The setup-complete CLI command
 * is the only writer.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { hasCompletedModels } from "./config.js";
import { readValidatedLock, isSetupComplete as lockSays } from "./lock.js";
import { setupPendingPath } from "./setup-pending.js";

const REQUIRED_DOCS = [
  "docs/agents/issue-tracker.md",
  "docs/agents/domain.md",
  "docs/agents/triage-labels.md",
];

export function modelsComplete(repoRoot, configValue) {
  if (configValue === undefined) return false;
  return hasCompletedModels(configValue);
}

/**
 * True when the consumer has completed the chat-only GitHub
 * setup workflow. The check is deterministic from on-disk
 * artifacts so a follow-up resume does not depend on a flag
 * the user can edit.
 *
 * @param {string} repoRoot
 * @param {object} [configValue]
 * @returns {Promise<{ ok: boolean, missing: string[], config: { ok: boolean, lock: { ok: boolean, setupComplete: boolean } } }>}
 */
export async function setupComplete(repoRoot, configValue) {
  const missing = [];
  for (const rel of REQUIRED_DOCS) {
    const path = resolve(repoRoot, rel);
    if (!existsSync(path)) missing.push(rel);
  }
  const agentsPath = resolve(repoRoot, "AGENTS.md");
  let agentsOk = false;
  if (existsSync(agentsPath)) {
    try {
      const raw = await readFile(agentsPath, "utf8");
      agentsOk = /##\s+Ship workflow\b/.test(raw);
    } catch {
      agentsOk = false;
    }
    if (!agentsOk) missing.push("AGENTS.md Ship workflow block");
  } else {
    missing.push("AGENTS.md");
  }
  const lockResult = await readValidatedLock(repoRoot);
  const cfgOk = modelsComplete(repoRoot, configValue);
  const markerPath = setupPendingPath(repoRoot);
  if (existsSync(markerPath)) missing.push("setup-pending marker");
  // The lock check is satisfied when the lock parses cleanly
  // and is on a supported schema. We do NOT require
  // setupComplete=true here; that's the very thing the
  // setup-complete command is elevating. Re-using the lock
  // setupComplete bit as the gate would force the gate to hold
  // its own key.
  const lockOk = lockResult.kind === "ok" || lockResult.kind === "missing";
  const ok = cfgOk && lockOk && missing.length === 0;
  return {
    ok,
    missing,
    config: { ok: cfgOk, lock: { ok: lockOk, setupComplete: lockSays(lockResult.lock) } },
  };
}

export const SETUP_PENDING_REL_PATH = ".opencode/ship.setup-pending.json";

export const SETUP_REQUIREMENTS = Object.freeze({
  docs: REQUIRED_DOCS,
  agentFile: "AGENTS.md",
  markerPath: SETUP_PENDING_REL_PATH,
});
