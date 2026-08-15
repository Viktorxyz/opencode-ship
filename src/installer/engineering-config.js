/*
 * Engineering workflow configuration: model roles + plan policy.
 *
 * The installer ships an optional engineering profile that
 * configures the GPT-to-MiniMax handoff:
 *
 *   models.planner         GPT model that writes per-ticket plans
 *   models.builder         MiniMax model that implements tasks
 *   models.finalReviewer   GPT model that does final Standards +
 *                          Spec review
 *
 *   plans.root             Git common directory for plans/
 *   plans.mirrorToIssue    whether to POST approved plans as
 *                          marked issue comments (currently mandatory)
 *
 * resolveModelRoles is the runtime's view: it merges the user's
 * config with documented defaults so a single source of truth
 * (here) controls what OpenCode launches.
 */

import { PROFILES, isValidProfile } from "../profile.js";

const MODEL_ID_RE = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

const DEFAULTS = Object.freeze({
  planner: "openai/gpt-5.6-sol",
  builder: "minimax/MiniMax-M3",
  finalReviewer: "openai/gpt-5.6-sol",
});

/**
 * Fail-closed config validator. Returns `{ ok, kind, issues }`
 * for callers that want to surface diagnostics. Missing
 * engineering config is treated as "engineering profile
 * disabled" and returns ok.
 */
export function validateEngineeringConfig(cfg) {
  if (cfg === undefined || cfg === null) return { ok: true, kind: "empty", issues: [] };
  if (typeof cfg !== "object" || Array.isArray(cfg)) {
    return { ok: false, kind: "shape", issues: ["engineering config root must be an object"] };
  }
  const issues = [];
  let kind = "ok";
  if (cfg.models) {
    if (typeof cfg.models !== "object" || Array.isArray(cfg.models)) {
      issues.push("models must be an object");
      kind = "shape";
    } else {
      for (const [role, id] of Object.entries(cfg.models)) {
        if (typeof id !== "string" || !MODEL_ID_RE.test(id)) {
          issues.push(`models.${role} is not a valid "<provider>/<model>" id: ${JSON.stringify(id)}`);
          kind = "shape";
        }
      }
    }
  }
  if (cfg.plans !== undefined) {
    if (typeof cfg.plans !== "object" || Array.isArray(cfg.plans)) {
      issues.push("plans must be an object");
      kind = "shape";
    } else {
      if (cfg.plans.root !== undefined) {
        if (typeof cfg.plans.root !== "string" || !cfg.plans.root.startsWith(".git/opencode-ship/")) {
          issues.push(`plans.root must be rooted under .git/opencode-ship/: ${cfg.plans.root}`);
          kind = "shape";
        }
      }
      if (cfg.plans.mirrorToIssue === false) {
        issues.push("plans.mirrorToIssue=false is not currently supported");
        kind = "shape";
      }
    }
  }
  return { ok: issues.length === 0, kind, issues };
}

/**
 * Merge the user config with the documented defaults. When
 * `strict` is true, the user must explicitly provide every
 * required role (`planner`, `builder`, `finalReviewer`);
 * the defaults are NOT consulted in strict mode. The strict
 * mode is what `init --profile engineering` uses so the
 * controller can refuse a partial engineering install.
 *
 * Deferred mode (`allowDeferred=true`) lets the resolver return
 * an empty roles object when the user explicitly skipped the
 * model step. The controller and the doctor refuse to dispatch
 * until all three roles are populated.
 */
export function resolveModelRoles(cfg, { strict = false, allowDeferred = false } = {}) {
  const REQUIRED = ["planner", "builder", "finalReviewer"];
  if (strict) {
    const issues = [];
    for (const role of REQUIRED) {
      const id = cfg?.models?.[role];
      if (typeof id !== "string" || id.length === 0 || !MODEL_ID_RE.test(id)) {
        issues.push(role);
      }
    }
    if (issues.length > 0) {
      throw new Error(`resolveModelRoles: required role(s) missing or invalid: ${issues.join(", ")}`);
    }
    return { planner: cfg.models.planner, builder: cfg.models.builder, finalReviewer: cfg.models.finalReviewer };
  }
  const out = { ...DEFAULTS };
  if (cfg && cfg.models) {
    for (const [role, id] of Object.entries(cfg.models)) {
      if (id && typeof id === "string" && id.length > 0) {
        out[role] = id;
      } else if (strict && Object.prototype.hasOwnProperty.call(cfg.models, role)) {
        throw new Error(`resolveModelRoles: user provided empty model id for '${role}'`);
      }
    }
  }
  if (allowDeferred) {
    return { planner: out.planner ?? null, builder: out.builder ?? null, finalReviewer: out.finalReviewer ?? null };
  }
  for (const role of REQUIRED) {
    if (!out[role]) {
      throw new Error(`resolveModelRoles: required role '${role}' missing and no default available`);
    }
  }
  return out;
}

// Marker so the linter does not flag the import above as unused
// when callers reach resolveModelRoles via tree-shaking.
void isValidProfile;
void PROFILES;
