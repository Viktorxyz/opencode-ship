import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolvePackageRoot } from "./package-root.js";

export const MODEL_ROLES = ["planner", "builder", "finalReviewer"];

function failDefaults(message) {
  const err = new Error(message);
  /** @type {any} */ (err).catalogValidation = true;
  throw err;
}

function readJson(path) {
  if (!existsSync(path)) {
    failDefaults(`defaults file missing: ${path}`);
  }
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    failDefaults(`defaults file unreadable: ${path}: ${e?.message ?? e}`);
  }
  if (raw.trim().length === 0) {
    failDefaults(`defaults file empty: ${path}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    failDefaults(`defaults file is not JSON: ${path}: ${e?.message ?? e}`);
  }
}

function assertRoles(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failDefaults(`${label} must be an object with planner, builder, finalReviewer`);
  }
  for (const role of MODEL_ROLES) {
    if (typeof value[role] !== "string" || value[role].length === 0) {
      failDefaults(`${label} missing role: ${role}`);
    }
  }
}

export function loadWorkflowModelDefaults() {
  const root = resolvePackageRoot(import.meta.url);
  const current = readJson(resolve(root, "assets/defaults/workflow-models.json"));
  const history = readJson(resolve(root, "assets/defaults/workflow-models.history.json"));
  assertRoles(current, "workflow-models.json");
  if (!Array.isArray(history)) {
    failDefaults("workflow-models.history.json must be a JSON array");
  }
  for (let i = 0; i < history.length; i++) {
    assertRoles(history[i], `workflow-models.history.json[${i}]`);
  }
  return { current, history };
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

export function resolveWorkflowModels({ configModels, lockModels, cliModels, current, history }) {
  const config = configModels && typeof configModels === "object" ? configModels : {};
  const lock = lockModels && typeof lockModels === "object" ? lockModels : {};
  const cli = cliModels && typeof cliModels === "object" ? cliModels : {};
  const hist = Array.isArray(history) ? history : [];

  const models = {};
  const provenance = {};
  const changedRoles = [];

  for (const role of MODEL_ROLES) {
    let id;
    let source;

    if (isNonEmptyString(cli[role])) {
      source = "override";
      id = cli[role];
    } else if (lock[role]?.source === "override") {
      source = "override";
      id = isNonEmptyString(config[role]) ? config[role] : lock[role].applied;
    } else if (lock[role]?.source === "default") {
      source = "default";
      id = current[role];
    } else if (!isNonEmptyString(config[role])) {
      source = "default";
      id = current[role];
    } else if (config[role] === current[role] || hist.some((entry) => entry?.[role] === config[role])) {
      source = "default";
      id = current[role];
    } else {
      source = "override";
      id = config[role];
    }

    models[role] = id;
    provenance[role] = { source, applied: id };
    if (id !== config[role]) changedRoles.push(role);
  }

  return { models, provenance, changedRoles };
}
