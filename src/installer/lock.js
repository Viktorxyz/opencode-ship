/*
 * Install manifest persistence.
 *
 * Locks live at `.opencode/ship.lock.json`. This module handles
 * read, write, integrity computation, and migration from v0.1.x,
 * v0.3, and 1.0.x legacy locks into the current contract.
 *
 * `integrity.lockSha256` is computed over the lock contents minus
 * the `integrity` field itself, so consumers and installers can
 * detect tampering.
 *
 * Schema enforcement: `CURRENT_LOCK_SCHEMA` is the only schema the
 * installer writes. `validateLock` distinguishes between "no lock
 * here" (treated as a fresh install by callers), "supported lock"
 * (clean path), and "unsupported lock" (caller maps to exit 5).
 * Integrity mismatches and parse failures map to exit 3.
 *
 * Cleanup retry state (formerly `cleanupPending` on the lock) lives
 * under `<git-common-dir>/opencode-ship/cleanup-pending.json` so
 * the install lock stays a pure install provenance record.
 */

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve, posix } from "node:path";
import { bytesHashString } from "./hash.js";
import { stableStringify } from "./json-pointer.js";
import { DEFAULT_PROFILE, isValidProfile } from "../profile.js";

export const CURRENT_LOCK_SCHEMA = 4;

/**
 * Lock schema revisions:
 *   1 - legacy manager-aware schema; `manager.schemaVersion` and
 *       `contractVersion` are both 1; integrity section present;
 *       `manager.profile` is absent and resolves to legacy core.
 *   2 - profile-aware schema: `manager.profile` is REQUIRED on
 *       newly written locks and validated to be one of PROFILES.
 *       v1 locks still validate (legacy core) so consumers on
 *       earlier versions can upgrade without manual migration.
 *   3 - reversible profile schema: every root pointer record
 *       carries a `scope` (core | engineering), the
 *       `previous` value is preserved across updates so uninstall
 *       can byte-restore the preinstall root, the transaction
 *       covers lock deletion, and engineering-to-core downgrades
 *       remove engineering-scoped pointers and Plan Mode. v1 and
 *       v2 locks still validate so existing consumers can upgrade.
 *   4 - setup-complete schema: `manager.setupComplete` carries
 *       whether the user has finished `/setup-ship-workflow`;
 *       the install lock no longer carries `cleanupPending`
 *       (that state moved to `<git-common-dir>/opencode-ship/cleanup-pending.json`).
 *       v1/v2/v3 locks still validate so existing consumers can upgrade.
 */
export function lockSchemaRevision() {
  return CURRENT_LOCK_SCHEMA;
}

export function lockPath(repoRoot) {
  return resolve(repoRoot, ".opencode", "ship.lock.json");
}

export async function readLock(repoRoot) {
  const path = lockPath(repoRoot);
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function writeLock(repoRoot, lock) {
  const path = lockPath(repoRoot);
  await mkdir(dirname(path), { recursive: true });
  const integrity = computeIntegrity(lock);
  const finalLock = { ...lock, integrity };
  const raw = JSON.stringify(finalLock, null, 2) + "\n";
  const tmp = `${path}.tmp`;
  await writeFile(tmp, raw, "utf8");
  await rename(tmp, path);
  return path;
}

export function computeIntegrity(lock) {
  const { integrity: _ignored, ...without } = lock ?? {};
  void _ignored;
  return {
    lockSha256: bytesHashString(stableStringify(without)),
  };
}

export async function validateIntegrity(lock) {
  if (!lock?.integrity?.lockSha256) return false;
  const expected = computeIntegrity(lock).lockSha256;
  return expected === lock.integrity.lockSha256;
}

/**
 * Strip runtime state that no longer belongs on the install lock.
 *
 * v3 (and earlier) locks carried `cleanupPending` as part of the
 * install provenance. From v4 that state lives under the Git
 * common directory. When we read any pre-v4 lock for upgrade we
 * silently drop `cleanupPending` from the in-memory copy so the
 * next write produces a v4 lock without it.
 */
export function normalizeLegacyLock(lock) {
  if (!lock || typeof lock !== "object") return lock;
  const { cleanupPending: _drop, ...rest } = lock;
  void _drop;
  return rest;
}

/**
 * Strict lock validator.
 *
 * Returns `{ ok, issues, kind }` so callers can map failures to the
 * installer's exit codes:
 *
 *   kind: "missing"        → lock file absent (treated as fresh)
 *   kind: "schema"         → unsupported contractVersion / schemaVersion (exit 5)
 *   kind: "integrity"      → tampered or malformed on disk (exit 3)
 *   kind: "shape"          → known shape but fields are wrong (exit 3)
 *   kind: "ok"             → lock is supported and intact
 */
export function validateLock(rawLock) {
  if (rawLock === null || rawLock === undefined) {
    return { ok: true, kind: "missing", issues: [] };
  }
  if (typeof rawLock !== "object" || Array.isArray(rawLock)) {
    return { ok: false, kind: "shape", issues: ["lock root must be an object"] };
  }

  const issues = [];
  let kind = "ok";

  // v1/v2/v3 locks are accepted as legacy so consumers on those
  // versions can upgrade without manual migration. Resolution of
  // the missing or legacy profile happens in profile precedence
  // (sibling slice).
  if (
    rawLock.contractVersion !== CURRENT_LOCK_SCHEMA &&
    rawLock.contractVersion !== 3 &&
    rawLock.contractVersion !== 2 &&
    rawLock.contractVersion !== 1
  ) {
    issues.push(`unsupported contractVersion: ${JSON.stringify(rawLock.contractVersion)} (expected ${CURRENT_LOCK_SCHEMA}, 3, 2, or 1)`);
    kind = "schema";
  }

  const manager = rawLock.manager;
  if (manager === undefined) {
    issues.push("manager section missing");
    kind = kind === "ok" ? "shape" : kind;
  } else if (typeof manager !== "object" || manager === null) {
    issues.push("manager section must be an object");
    kind = kind === "ok" ? "shape" : kind;
  } else if (
    manager.schemaVersion !== CURRENT_LOCK_SCHEMA &&
    manager.schemaVersion !== 3 &&
    manager.schemaVersion !== 2 &&
    manager.schemaVersion !== 1
  ) {
    issues.push(`unsupported manager.schemaVersion: ${JSON.stringify(manager.schemaVersion)} (expected ${CURRENT_LOCK_SCHEMA}, 3, 2, or 1)`);
    kind = "schema";
  } else if (manager.name !== "opencode-ship") {
    issues.push(`unknown manager.name: ${JSON.stringify(manager.name)}`);
    kind = "shape";
  } else if (
    rawLock.contractVersion >= 2 &&
    manager.schemaVersion >= 2 &&
    manager.profile !== undefined &&
    manager.profile !== "core" &&
    manager.profile !== "engineering"
  ) {
    issues.push(`invalid manager.profile: ${JSON.stringify(manager.profile)} (expected one of: engineering, core [legacy])`);
    kind = "shape";
  }

  if (!rawLock.files || !Array.isArray(rawLock.files)) {
    issues.push("files must be an array");
    kind = kind === "ok" ? "shape" : kind;
  } else {
    for (const entry of rawLock.files) {
      if (!entry || typeof entry !== "object" || !isSafeManagedPath(entry.path)) {
        issues.push(`unsafe managed file path: ${JSON.stringify(entry?.path)}`);
        kind = kind === "ok" ? "shape" : kind;
      }
    }
  }

  if (!rawLock.integrity || typeof rawLock.integrity !== "object") {
    issues.push("integrity section missing");
    kind = kind === "ok" ? "shape" : kind;
  } else {
    const expected = computeIntegrity(rawLock).lockSha256;
    if (expected !== rawLock.integrity.lockSha256) {
      issues.push(`integrity mismatch: stored ${rawLock.integrity.lockSha256} != computed ${expected}`);
      kind = "integrity";
    }
  }

  return { ok: issues.length === 0, kind, issues };
}

export function isSafeManagedPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\")) return false;
  if (posix.isAbsolute(value) || posix.normalize(value) !== value) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/**
 * Read + validate in one step. Always returns a discriminated
 * result; never throws. Callers translate `kind` into exit codes.
 */
export async function readValidatedLock(repoRoot) {
  const path = lockPath(repoRoot);
  if (!existsSync(path)) {
    return { kind: "missing", lock: null, issues: [] };
  }
  let raw;
  try {
    const text = await readFile(path, "utf8");
    raw = JSON.parse(text);
  } catch (e) {
    return {
      kind: "integrity",
      lock: null,
      issues: [`unable to parse lock JSON: ${e?.message ?? String(e)}`],
    };
  }
  const validation = validateLock(raw);
  if (validation.ok) {
    return {
      kind: validation.kind,
      lock: normalizeLegacyLock(raw),
      issues: [],
    };
  }
  return { kind: validation.kind, lock: null, issues: validation.issues };
}

export async function migrateLegacyLock(repoRoot) {
  const legacy = resolve(repoRoot, ".opencode", "delivery.lock.json");
  if (!existsSync(legacy)) return null;
  try {
    const text = await readFile(legacy, "utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * True when the lock carries the post-1.1 setup-complete contract.
 * Pre-v4 locks do not, so we conservatively assume setup is not
 * complete and let the executor route the next ship-deliver through
 * `/setup-ship-workflow`.
 */
export function isSetupComplete(lock) {
  if (!lock || typeof lock !== "object") return false;
  const manager = lock.manager;
  if (!manager || typeof manager !== "object") return false;
  return manager.setupComplete === true;
}

void DEFAULT_PROFILE;
void isValidProfile;
