/*
 * Reconciliation planner.
 *
 * Compares the current on-disk bytes against the desired bytes and
 * against the previous lock to produce an immutable, ordered plan.
 * The plan covers:
 *   - file operations (managed plugin, agents, skills, ship.config.json,
 *     ship.lock.json);
 *   - root opencode.json / opencode.jsonc operations (Build-agent
 *     permissions only, expressed as JSON pointer edits);
 *   - config synthesis (only if absent and allowed).
 *
 * Each entry has:
 *   - kind:    "create" | "update" | "noop" | "delete" | "converge" | "conflict"
 *   - op:      the operation type ("file", "config", "root-config")
 *   - target:  the absolute path or root-config descriptor
 *   - bytes:   the desired bytes (create/update only)
 *   - reason:  a human-readable reason
 *
 * `noop`/`converge` actions do not require file writes but may
 * require lock refresh. `conflict` actions are NEVER applied; the
 * CLI converts them into a precise conflict report and bails out.
 */

import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { CATALOG } from "./catalog.js";
import { bytesHashString } from "./hash.js";
import { loadConfig, renderDefaultConfig } from "./config.js";
import { isSafeManagedPath } from "./lock.js";
import {
  setPointer,
  getPointer,
  stableStringify,
} from "./json-pointer.js";
import { POINTER_ENTRIES, applyOwnedPointers, findRootConfig, readRootConfig, defaultRootConfigPath } from "./root-config.js";
import {
  planRootReconciliation,
  desiredPointersForProfile,
  PLAN_MODE_POINTER as RECON_PLAN_MODE_POINTER,
} from "./root-reconciliation.js";

async function readBytes(path) {
  if (!existsSync(path)) return null;
  const buf = await readFile(path);
  const fileStat = await stat(path);
  return { bytes: buf, hash: bytesHashString(buf.toString("utf8")), mode: fileStat.mode & 0o777 };
}

async function readDesiredBytes(source) {
  if (!source || !existsSync(source)) return null;
  const buf = await readFile(source);
  return { bytes: buf, hash: bytesHashString(buf.toString("utf8")) };
}

function lookupLockedFile(lock, targetPath) {
  if (!lock?.files) return null;
  return lock.files.find((entry) => entry.path === targetPath) ?? null;
}

async function planManagedFile({ entry, repoRoot, lock, allowUnowned, renderedOverride = null }) {
  const override = renderedOverride && renderedOverride.get?.(entry.path);
  const targetPath = `${repoRoot}/${entry.path}`;
  const locked = lookupLockedFile(lock, entry.path);
  const current = await readBytes(targetPath);
  const desired = override
    ? { bytes: override.bytes, hash: override.sha256 }
    : await readDesiredBytes(entry.source);
  if (!current) {
    return {
      kind: "create", op: "file", target: targetPath, relPath: entry.path,
      kindOf: entry.kind, bytes: desired?.bytes ?? Buffer.alloc(0),
      sha256: desired?.hash, mode: 0o644,
      reason: override ? "rendered agent with configured model" : "managed file missing",
    };
  }
  if (desired.hash === current.hash) {
    if (locked?.sha256 === current.hash) {
      return { kind: "noop", op: "file", target: targetPath, relPath: entry.path };
    }
    return {
      kind: "converge", op: "file", target: targetPath, relPath: entry.path,
      reason: "current bytes already equal desired; refresh lock only",
    };
  }
  if (locked?.sha256 === current.hash) {
    return {
      kind: "update", op: "file", target: targetPath, relPath: entry.path,
      bytes: desired?.bytes ?? Buffer.alloc(0),
      sha256: desired?.hash, mode: 0o644,
      reason: override
        ? "rendered agent with new configured model"
        : "safe update: previous lock matches current bytes",
    };
  }
  if (locked?.sha256 && locked.sha256 !== current.hash && allowUnowned) {
    return {
      kind: "update", op: "file", target: targetPath, relPath: entry.path,
      bytes: desired?.bytes ?? Buffer.alloc(0),
      sha256: desired?.hash, mode: 0o644,
      reason: "force update: lock present, current bytes modified",
    };
  }
  return {
    kind: "conflict", op: "file", target: targetPath, relPath: entry.path,
    currentSha: current.hash, previousSha: locked?.sha256 ?? null, desiredSha: desired?.hash,
    reason: locked?.sha256 == null
      ? "managed file already exists; bytes differ from upstream"
      : "managed file is locally modified",
  };
}

export async function planFileInstall({ repoRoot, lock, allowUnowned = false, catalog = CATALOG, renderedOverride = null }) {
  const plan = [];
  for (const entry of catalog) {
    plan.push(await planManagedFile({ entry, repoRoot, lock, allowUnowned, renderedOverride }));
  }
  return plan;
}

/**
 * Plan the removal of files that were installed under the previous
 * profile but are not part of the new (active) profile. Used for
 * engineering -> core downgrades so engineering-only assets are
 * cleaned up atomically. Files are removed only when the bytes on
 * disk still match the lock; conflicting files become a
 * plan-conflict and the installer refuses to clobber them.
 */
export async function planStaleFileRemoval({ repoRoot, lock, staleCatalog }) {
  if (!Array.isArray(staleCatalog) || staleCatalog.length === 0) return [];
  const out = [];
  for (const entry of staleCatalog) {
    const targetPath = `${repoRoot}/${entry.path}`;
    const current = await readBytes(targetPath);
    if (!current) continue;
    const locked = lookupLockedFile(lock, entry.path);
    if (current.hash !== (locked?.sha256 ?? null)) {
      out.push({
        kind: "conflict", op: "file", target: targetPath, relPath: entry.path,
        reason: "stale profile asset is locally modified; refusing to remove",
      });
      continue;
    }
    out.push({
      kind: "delete", op: "file", target: targetPath, relPath: entry.path,
      reason: "remove stale profile asset on profile transition",
    });
  }
  return out;
}

export async function planMigrationCleanup({ repoRoot, lock, migrationReport, allowUnowned = false }) {
  const action = migrationReport?.actions?.find((entry) => entry.kind === "candidate-remove-legacy-plugin-path");
  if (!action) return [];

  const relPath = ".opencode/plugin/opencode-ship.js";
  const target = `${repoRoot}/${relPath}`;
  const current = await readBytes(target);
  if (!current) return [];

  const locked = lookupLockedFile(lock, relPath);
  if (locked?.sha256 === current.hash || allowUnowned) {
    return [{
      kind: "delete",
      op: "file",
      target,
      relPath,
      reason: "remove the lock-owned v0.2 singular plugin path",
    }];
  }

  return [{
    kind: "conflict",
    op: "file",
    target,
    relPath,
    currentSha: current.hash,
    previousSha: locked?.sha256 ?? null,
    reason: "legacy singular plugin is unowned or locally modified",
  }];
}

export async function planUninstall({ repoRoot, lock }) {
  if (!lock) return [];
  const plan = [];
  const activeProfile = lock?.manager?.profile ?? "core";
  for (const entry of lock.files ?? []) {
    if (!isSafeManagedPath(entry?.path)) {
      plan.push({
        kind: "conflict", op: "file", target: repoRoot, relPath: entry?.path ?? null,
        reason: "managed file path is unsafe; refusing filesystem access",
      });
      continue;
    }
    const targetPath = `${repoRoot}/${entry.path}`;
    const current = await readBytes(targetPath);
    if (!current) continue;
    if (current.hash !== entry.sha256) {
      plan.push({
        kind: "conflict", op: "file", target: targetPath, relPath: entry.path,
        reason: "managed file is locally modified; refusing to delete",
      });
      continue;
    }
    plan.push({ kind: "delete", op: "file", target: targetPath, relPath: entry.path });
  }
  // The root pointer reconciliation runs in the consumer's
  // opencode.json. Uninstall must restore the preinstall state
  // byte-by-byte, so the planner also includes the root-config
  // step in the uninstall plan. The transaction layer only knows
  // about `op: "file"`, so we surface the root-config update as a
  // file write that the transaction will commit atomically with
  // the rest of the plan.
  const rootPlan = await planRootReconciliation({
    repoRoot,
    profile: activeProfile,
    mode: "uninstall",
    previousRecords: (lock?.manager?.rootDocuments ?? []).flatMap((d) => d.pointers ?? []),
  });
  if (rootPlan?.kind === "conflict") {
    // Surface the root-pointer drift conflict so the uninstall
    // command fails closed (exit 3) instead of silently overwriting
    // the consumer's edits.
    plan.push({
      op: "root-config",
      kind: "conflict",
      target: rootPlan.target,
      relPath: rootPlan.relPath,
      reason: rootPlan.reason,
    });
  } else if (rootPlan && rootPlan.kind && rootPlan.kind !== "noop" && rootPlan.bytes) {
    plan.push({
      op: "file",
      kind: "update",
      target: rootPlan.target,
      relPath: rootPlan.relPath,
      bytes: rootPlan.bytes,
      mode: 0o644,
      reason: rootPlan.reason,
    });
  }
  // The lock file itself is removed by the uninstall command; we
  // surface it as a transactional step so the executor commits it
  // inside the journal.
  plan.push({
    kind: "delete",
    op: "file",
    target: `${repoRoot}/.opencode/ship.lock.json`,
    relPath: ".opencode/ship.lock.json",
    reason: "remove the install lock inside the transaction",
  });
  return plan;
}

export async function planConfigSynthesis({ repoRoot, detection, lock, forceOverwrite, migrationSeed = null, models = null }) {
  const existing = await loadConfig(repoRoot);
  const hasModelFlags = Boolean(models && (models.planner || models.builder || models.finalReviewer));
  // Model flags always patch the existing config so the lock
  // reflects the live model snapshot. This is not "force
  // overwrite" — unrelated fields are preserved — but it does
  // require writing the config back. Other updates still need
  // forceOverwrite.
  if (existing?.ok && !forceOverwrite && !hasModelFlags) {
    return {
      kind: "noop",
      op: "config",
      relPath: ".opencode/ship.config.json",
      target: existing.path,
      currentSha: existing.sha256,
      desiredSha: existing.sha256,
      configValue: existing.value,
      reason: "user config already present",
    };
  }
  let desiredValue = migrationSeed
    ?? (existing?.ok ? structuredClone(existing.value) : renderDefaultConfig(detection));
  if (hasModelFlags) {
    desiredValue = {
      ...desiredValue,
      schemaVersion: 2,
      profile: "engineering",
      workflow: {
        ...(desiredValue.workflow ?? {}),
        models: {
          planner: models.planner ?? desiredValue?.workflow?.models?.planner,
          builder: models.builder ?? desiredValue?.workflow?.models?.builder,
          finalReviewer: models.finalReviewer ?? desiredValue?.workflow?.models?.finalReviewer,
        },
        approval: {
          mirrorToIssue: true,
          maxFailedRounds: 3,
          ...(desiredValue?.workflow?.approval ?? {}),
        },
      },
    };
  }
  if (desiredValue.profile === "core") desiredValue.profile = "engineering";
  const desiredJson = JSON.stringify(desiredValue, null, 2) + "\n";
  const desiredSha = bytesHashString(desiredJson);
  const kind = existing?.ok && (forceOverwrite || hasModelFlags) ? "update" : "create";
  const reason = existing?.ok
    ? hasModelFlags && !forceOverwrite
      ? "patching workflow.models from CLI model flags"
      : "user config overwritten via --force-config"
    : migrationSeed
      ? "synthesising a default config from legacy adapter migration"
      : "synthesising a default config from detection";
  return {
    kind,
    op: "config",
    relPath: ".opencode/ship.config.json",
    target: `${repoRoot}/.opencode/ship.config.json`,
    currentSha: existing?.ok ? existing.sha256 : null,
    desiredSha,
    bytes: Buffer.from(desiredJson, "utf8"),
    configValue: desiredValue,
    reason,
  };
}

export async function planRootConfigApply({ repoRoot, lock, forceRepair, planMode = null }) {
  const previous = (lock?.manager?.rootDocuments ?? []).flatMap((d) => d.pointers ?? []);
  const previousProfile = lock?.manager?.profile ?? null;
  // From 1.1.0 the only profile is engineering; legacy "core"
  // profiles promote to engineering. The desired profile is
  // always engineering for the active install.
  const desiredProfile = "engineering";
  const isTransition = previousProfile !== null
    && previousProfile !== "engineering"
    && previousProfile !== "core";
  const mode = previous.length === 0 ? "install" : (isTransition ? "profile-transition" : "install");
  return planRootReconciliation({
    repoRoot,
    profile: desiredProfile,
    mode,
    previousRecords: previous,
    forceRepair: Boolean(forceRepair),
  });
}
