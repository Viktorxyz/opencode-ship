/*
 * Skill inventory: the sibling skill lock for project-local
 * dynamic skills installed by the trusted-auto skill discovery.
 *
 * Lives at `.opencode/ship.skills.lock.json` (sibling of
 * `ship.lock.json`) so a failed install never dirties the install
 * lock. Every entry carries source provenance (immutable commit
 * SHA), per-file SHA-256 hashes, and the install timestamp so
 * the audit/uninstall tools can detect drift.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { bytesHashString } from "./hash.js";
import { stableStringify } from "./json-pointer.js";

export const SKILL_LOCK_FILENAME = "ship.skills.lock.json";
export const SKILL_LOCK_VERSION = 1;

export function skillLockPath(repoRoot) {
  return resolve(repoRoot, ".opencode", SKILL_LOCK_FILENAME);
}

export function integrity(lock) {
  const { integrity: _ignored, ...without } = lock ?? {};
  void _ignored;
  return { lockSha256: bytesHashString(stableStringify(without)) };
}

export async function readSkillLock(repoRoot) {
  const path = skillLockPath(repoRoot);
  if (!existsSync(path)) return { version: SKILL_LOCK_VERSION, skills: [] };
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? { version: parsed.version ?? SKILL_LOCK_VERSION, skills: Array.isArray(parsed.skills) ? parsed.skills : [] }
      : { version: SKILL_LOCK_VERSION, skills: [] };
  } catch {
    return { version: SKILL_LOCK_VERSION, skills: [] };
  }
}

export async function writeSkillLock(repoRoot, lock) {
  const path = skillLockPath(repoRoot);
  await mkdir(dirname(path), { recursive: true });
  const safe = { version: SKILL_LOCK_VERSION, skills: Array.isArray(lock?.skills) ? lock.skills : [] };
  const sealed = { ...safe, integrity: integrity(safe) };
  await writeFile(path, JSON.stringify(sealed, null, 2) + "\n", "utf8");
  return path;
}

export function findSkill(lock, name) {
  if (!lock || !Array.isArray(lock.skills)) return null;
  return lock.skills.find((s) => s.name === name) ?? null;
}
