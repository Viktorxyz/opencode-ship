import { listSkills } from "./registry.js";
import { readPolicy, isAutoInstallable } from "./policy.js";
import { stackQueries, readPackageJson } from "./stack-queries.js";

const MANAGED_SKILL_NAMES = new Set([
  "delivery-workflow",
  "planning-research-checkpoint",
  "skill-discovery",
  "setup-ship-workflow",
]);

/**
 * @param {{
 *   repoRoot?: string,
 *   mode?: "init" | "deliver",
 *   issueText?: string,
 *   listSkillsFn?: Function,
 *   installFn?: Function,
 *   policy?: object,
 * }} [input]
 */
export async function syncSkills({
  repoRoot,
  mode: _mode,
  issueText = "",
  listSkillsFn,
  installFn,
  policy,
} = {}) {
  const queries = stackQueries({
    packageJson: readPackageJson(repoRoot),
    issueText,
  });
  const installed = [];
  const skippedUntrusted = [];
  const skippedPolicy = [];
  const errors = [];
  let registryUnavailable = false;
  const seen = new Set();
  const resolvedPolicy = policy ?? await readPolicy(repoRoot);
  const listFn = listSkillsFn ?? listSkills;
  const cap = resolvedPolicy.maxTrustedPerRun ?? 5;

  for (const query of queries) {
    let result;
    try {
      result = await listFn({ repoRoot, query });
    } catch (err) {
      registryUnavailable = true;
      errors.push(String(err?.message ?? err));
      continue;
    }
    if (!result?.ok) {
      registryUnavailable = true;
      errors.push(result?.error?.kind ?? "registry-unavailable");
      continue;
    }
    for (const candidate of result.candidates ?? []) {
      const skillName = candidate.skill;
      const pkg = candidate.package;
      if (!skillName || seen.has(skillName)) continue;
      if (MANAGED_SKILL_NAMES.has(skillName)) {
        skippedPolicy.push({ package: pkg, skillName, reason: "managed-skill" });
        seen.add(skillName);
        continue;
      }
      const decision = isAutoInstallable(candidate, resolvedPolicy);
      if (!decision.ok) {
        const entry = { package: pkg, skillName, reason: decision.reason };
        if (decision.reason === "untrusted-owner") skippedUntrusted.push(entry);
        else skippedPolicy.push(entry);
        seen.add(skillName);
        continue;
      }
      if (installed.length >= cap) {
        skippedPolicy.push({ package: pkg, skillName, reason: "max-per-run" });
        seen.add(skillName);
        continue;
      }
      if (typeof installFn !== "function") {
        errors.push(`installFn missing for ${skillName}`);
        continue;
      }
      let outcome;
      try {
        outcome = await installFn({ package: pkg, skillName, version: candidate.version });
      } catch (err) {
        errors.push(String(err?.message ?? err));
        continue;
      }
      if (outcome?.ok) {
        installed.push({ package: pkg, skillName });
        seen.add(skillName);
        continue;
      }
      const message = String(outcome?.message ?? "");
      if (/already exists/i.test(message)) {
        skippedPolicy.push({ package: pkg, skillName, reason: "destination-exists" });
        seen.add(skillName);
        continue;
      }
      errors.push(message || `install failed: ${skillName}`);
    }
  }

  return {
    queries,
    installed,
    skippedUntrusted,
    skippedPolicy,
    errors,
    registryUnavailable,
  };
}
