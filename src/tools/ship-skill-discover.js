/**
 * ship_skill_discover tool.
 *
 * Query the public skill registry and partition the result
 * into auto-installable vs. needs-approval candidates. The
 * partition uses the consumer's trusted-owner allowlist, the
 * minimum install threshold, and the per-run install cap.
 *
 * The tool is read-only; it never installs, registers, or
 * mutates the repo. The controller must call
 * ship_skill_install for each auto-installable candidate.
 */
import { success, failure } from "./envelope.js";
import { listSkills } from "../skills/registry.js";
import { readPolicy, isAutoInstallable } from "../skills/policy.js";

export function createSkillDiscoverTool(deps) {
  return async function skillDiscover(input) {
    const opId = input.operationId ?? `skill-discover-${Date.now().toString(36)}`;
    const query = String(input.query ?? "");
    if (!query) {
      return failure("skill-discover", "query required", { operationId: opId, retryable: false });
    }
    let policy;
    try {
      policy = await readPolicy(deps.repoRoot);
    } catch (err) {
      return failure("skill-discover", `policy unreadable: ${err?.message ?? err}`, { operationId: opId, retryable: false });
    }
    let result;
    try {
      result = await listSkills({ repoRoot: deps.repoRoot, query });
    } catch (err) {
      return failure("skill-discover", `registry unavailable: ${err?.message ?? err}`, { operationId: opId, retryable: true });
    }
    if (result.ok !== true) {
      const errObj = /** @type {{ error?: { kind?: string } }} */ (result);
      const kind = errObj.error?.kind ?? "registry-unavailable";
      return failure("skill-discover", kind, { operationId: opId, retryable: true });
    }
    const candidates = Array.isArray(result.candidates) ? result.candidates : [];
    const auto = [];
    const needsApproval = [];
    let autoCount = 0;
    for (const candidate of candidates) {
      if (policy.blocklist.includes(candidate.package)) continue;
      const decision = isAutoInstallable(candidate, policy);
      if (decision.ok && autoCount < policy.maxTrustedPerRun) {
        auto.push(candidate);
        autoCount += 1;
      } else {
        needsApproval.push({ ...candidate, reason: decision.reason ?? "needs-approval" });
      }
    }
    return success("skill-discover", {
      query,
      policy,
      auto,
      needsApproval,
      total: candidates.length,
    }, { operationId: opId });
  };
}
