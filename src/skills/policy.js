/**
 * Trusted skill policy.
 *
 * Single source of truth for the installer's allowed skill
 * publishers, the install threshold, and the user-owned
 * blocklist. The policy is read from the engineering config
 * (`skillDiscovery`) with a documented default so consumers
 * can install `opencode-ship` without configuring skills.
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { bytesHashString } from "../installer/hash.js";

export const DEFAULT_TRUSTED_OWNERS = Object.freeze([
  "vercel-labs",
  "anthropics",
  "obra",
  "mattpocock",
  "ComposioHQ",
]);

export const DEFAULT_MIN_INSTALLS = 1000;
export const MAX_TRUSTED_PER_RUN = 5;

const POLICY_PATH = ".opencode/ship.skills.policy.json";

export function policyPath(repoRoot) {
  return resolve(repoRoot, POLICY_PATH);
}

export function defaultPolicy() {
  return {
    trustedOwners: [...DEFAULT_TRUSTED_OWNERS],
    minInstalls: DEFAULT_MIN_INSTALLS,
    blocklist: [],
    maxTrustedPerRun: MAX_TRUSTED_PER_RUN,
  };
}

export async function readPolicy(repoRoot) {
  const path = policyPath(repoRoot);
  if (!existsSync(path)) return defaultPolicy();
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    return mergePolicy(defaultPolicy(), parsed);
  } catch {
    return defaultPolicy();
  }
}

export async function writePolicy(repoRoot, policy) {
  const path = policyPath(repoRoot);
  const merged = mergePolicy(defaultPolicy(), policy);
  await writeFile(path, JSON.stringify(merged, null, 2) + "\n", "utf8");
  return merged;
}

export function mergePolicy(base, override) {
  const out = { ...base };
  if (Array.isArray(override?.trustedOwners)) {
    out.trustedOwners = [...new Set(override.trustedOwners)];
  }
  if (Number.isInteger(override?.minInstalls)) {
    out.minInstalls = override.minInstalls;
  }
  if (Array.isArray(override?.blocklist)) {
    out.blocklist = [...new Set(override.blocklist)];
  }
  if (Number.isInteger(override?.maxTrustedPerRun)) {
    out.maxTrustedPerRun = override.maxTrustedPerRun;
  }
  return out;
}

/**
 * Decide whether a candidate is auto-installable for the
 * current run. The decision is deterministic from the policy
 * and the candidate descriptor.
 *
 * @param {object} candidate { skill, package, installs }
 * @param {object} policy
 * @returns {{ ok: boolean, reason?: string }}
 */
export function isAutoInstallable(candidate, policy) {
  if (!candidate || typeof candidate !== "object") {
    return { ok: false, reason: "missing-candidate" };
  }
  if ((policy.blocklist ?? []).includes(candidate.package)) {
    return { ok: false, reason: "blocked" };
  }
  const owner = String(candidate.package).split("/")[0];
  if (!(policy.trustedOwners ?? []).includes(owner)) {
    return { ok: false, reason: "untrusted-owner" };
  }
  if (candidate.installs < (policy.minInstalls ?? DEFAULT_MIN_INSTALLS)) {
    return { ok: false, reason: "below-threshold" };
  }
  return { ok: true };
}

export function policyHash(policy) {
  return bytesHashString(JSON.stringify(policy));
}
