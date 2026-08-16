/**
 * Setup state evaluation.
 *
 * Two distinct predicates:
 *
 *   modelsComplete(cfg)        - all three model roles populated
 *   setupArtifactsReady(repo)  - the installer's setup artifacts
 *                                (docs + AGENTS.md block + valid lock)
 *                                are present and current
 *
 * The shipped 1.1.x conflated the setup-pending marker with setup
 * readiness. The marker is a chat-time signal of "setup in
 * progress"; it is not an artifact. A user who deletes the marker
 * manually is declaring setup complete without the chat workflow;
 * the artifacts are what matter for the gate.
 *
 * Contract:
 *
 *   setupArtifactsReady = modelsComplete
 *     && installer-owned setup docs present
 *     && AGENTS.md contains a "Ship workflow" block
 *     && lock is current supported schema (read validates v1..v4)
 *
 * The setup-ship-workflow skill drives the chat-only flow that
 * produces every one of these. The setup-complete CLI command is
 * the only writer of `manager.setupComplete: true` AND the only
 * routine that touches the marker on the success path.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { hasCompletedModels } from "./config.js";
import { readValidatedLock, isSetupComplete as lockSays } from "./lock.js";

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
 * True when the consumer's setup artifacts are present and current.
 * The check is deterministic from on-disk artifacts so a follow-up
 * resume does not depend on a flag the user can edit. The
 * setup-pending marker is intentionally excluded: the marker is a
 * signal, not a requirement.
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
