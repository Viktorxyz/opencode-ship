/*
 * opencode-ship command: setup-complete.
 *
 * Sole writer of `lock.manager.setupComplete: true`. Validates
 * every prerequisite deterministically from on-disk artifacts:
 *
 *   - all three workflow models populated
 *   - lock v4 + integrity clean
 *   - docs/agents/issue-tracker.md present
 *   - docs/agents/domain.md present
 *   - docs/agents/triage-labels.md present
 *   - AGENTS.md contains a "## Ship workflow" block
 *
 * The setup-pending marker is a chat-time signal of "setup is in
 * progress"; it is NOT an artifact. The setup-complete command
 * does not consult it for the gate; it only clears it as part of
 * the successful commit step. A user who manually deletes the
 * marker is declaring setup complete out of band; their artifacts
 * still have to pass this gate.
 *
 * Transactional ordering:
 *   1. evaluate setup artifacts (no marker)
 *   2. if invalid, return diagnostic; no writes
 *   3. if valid, write the lock with setupComplete=true and clear
 *      the marker as part of the same install transaction
 *
 * On success, the lock is rewritten with `setupComplete: true`
 * AND the setup-pending marker is removed. The explicit gate
 * is bidirectional: kit-removed or doc-deleted between calls
 * drops the lock back to incomplete.
 *
 * The setup-ship-workflow skill is the consumer-facing driver
 * for this command; this binary command is the contract surface.
 */

import { previewInstall, commitInstall, serializePlan } from "../executor.js";
import { loadConfig } from "../config.js";
import { setupComplete, SETUP_REQUIREMENTS } from "../setup-state.js";
import { isSetupPending, setupPendingPath, SETUP_PENDING_REL_PATH } from "../setup-pending.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export async function runSetupComplete(options) {
  const repoRoot = options.rootPath ?? process.cwd();
  if (!existsSync(resolve(repoRoot, ".git"))) {
    return emitFailure(2, "not a git repository", options.json);
  }
  const config = await loadConfig(repoRoot);
  const configValue = config?.ok ? config.value : null;
  // 1. Validate artifacts WITHOUT consulting the marker.
  const state = await setupComplete(repoRoot, configValue);
  const diagnostics = [];
  if (!state.config.ok) diagnostics.push("workflow.models incomplete");
  if (!state.config.lock.ok) diagnostics.push("lock is not v4 or fails integrity");
  if (state.missing.length > 0) {
    diagnostics.push(`missing: ${state.missing.join(", ")}`);
  }
  if (!state.ok) {
    return emitFailure(6, `setup incomplete: ${diagnostics.join("; ")}`, options.json, { state });
  }
  // 2. Capture marker presence as a non-authoritative signal that
  //    surfaces in the success envelope (helps audits distinguish
  //    chat-driven completion from out-of-band completion).
  const markerWasPresent = isSetupPending(repoRoot);
  // 3. Write the lock with setupComplete=true. The preview helper
  //    is the only path that computes the lock correctly; we run a
  //    no-op install to get a fresh lock, then patch the
  //    setupComplete flag. The fullSetupComplete flag passes
  //    through commitInstall to assembleLock.
  const preview = await previewInstall({
    rootPath: repoRoot,
    profile: "engineering",
    replaceManaged: false,
    forceConfig: false,
    forceRootConfig: false,
  });
  if (!preview.ok) {
    return emitFailure(2, `preview failed: ${preview.error?.kind ?? "unknown"}`, options.json);
  }
  if (preview.conflicts.length > 0) {
    return emitFailure(3, "managed files conflict; resolve with `opencode-ship update --replace-managed` first", options.json);
  }
  const committed = await commitInstall(preview, {
    json: options.json,
    command: "setup-complete",
    fullSetupComplete: true,
    transactionEntries: markerWasPresent ? [{
      op: "file",
      kind: "delete",
      target: setupPendingPath(repoRoot),
      relPath: SETUP_PENDING_REL_PATH,
      reason: "clear setup-pending marker in the setup-complete transaction",
    }] : [],
  });
  if (committed.extra?.exitCode !== 0) {
    return emitFailure(committed.extra?.exitCode ?? 1, "commit failed", options.json, { committed });
  }
  if (options.json) {
    process.stdout.write(JSON.stringify({
      reportVersion: 1,
      command: "setup-complete",
      status: "ok",
      setupComplete: true,
      markerWasPresent,
      requirements: SETUP_REQUIREMENTS,
      plan: serializePlan(committed.plan ?? []),
      summary: committed.summary ?? {},
      exitCode: 0,
    }, null, 2) + "\n");
  } else {
    process.stdout.write("opencode-ship: setup complete\n");
  }
  process.exitCode = 0;
  return committed;
}

function emitFailure(code, message, json, extra) {
  if (json) {
    process.stdout.write(JSON.stringify({
      reportVersion: 1,
      command: "setup-complete",
      status: "error",
      setupComplete: false,
      diagnostics: [message],
      ...(extra ?? {}),
      exitCode: code,
    }, null, 2) + "\n");
  } else {
    process.stdout.write(`opencode-ship: ${message}\n`);
  }
  process.exitCode = code;
  return { ok: false, exitCode: code };
}
