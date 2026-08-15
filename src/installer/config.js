/*
 * User-owned config loader & validator.
 *
 * The config file at .opencode/ship.config.json is user-owned. The
 * installer ONLY writes it on the first `init` if the file is
 * missing; subsequent runs preserve whatever the user has. Updates
 * do not rewrite the file unless the user explicitly opts in.
 *
 * If the file does not exist when the installer's plugin or CLI
 * boots, we synthesise one from the detected project. This lets the
 * verifier and the reviewer receive enough context to function
 * even before the user has committed a config.
 *
 * From 1.1.0 the engineering profile is the only profile. The
 * renderDefaultConfig helper emits a placeholder `workflow.models`
 * object so the setup-ship-workflow skill can fill it in; the ship
 * controller refuses to dispatch until all three role ids are non-
 * empty.
 */

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import shipConfigSchema from "../../schema/ship-config.schema.json" with { type: "json" };
import { validateSchema } from "./validation.js";
import { stableStringify } from "./json-pointer.js";
import { bytesHashString } from "./hash.js";

export function configPath(repoRoot) {
  return resolve(repoRoot, ".opencode", "ship.config.json");
}

export async function loadConfig(repoRoot) {
  const path = configPath(repoRoot);
  if (!existsSync(path)) return null;
  const raw = await readFile(path, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: { kind: "parse", path, message: e.message } };
  }
  const validation = validateSchema(parsed, shipConfigSchema);
  if (!validation.ok) {
    return { ok: false, error: { kind: "contract", path, issues: validation.issues } };
  }
  return {
    ok: true,
    path,
    raw,
    sha256: bytesHashString(raw),
    canonicalSha256: bytesHashString(stableStringify(parsed)),
    value: parsed,
  };
}

export async function writeConfig(repoRoot, value) {
  const path = configPath(repoRoot);
  await mkdir(dirname(path), { recursive: true });
  const raw = JSON.stringify(value, null, 2) + "\n";
  const tmp = `${path}.tmp`;
  await writeFile(tmp, raw, "utf8");
  await rename(tmp, path);
  return { path, raw, sha256: bytesHashString(raw) };
}

export function renderDefaultConfig(detection, overrides = {}) {
  const pm = detection?.packageManager ?? "npm";
  const safeBootstrap = Array.isArray(detection?.worktreeBootstrap) && detection.worktreeBootstrap.length
    ? detection.worktreeBootstrap
    : [["npm", "install"]];
  const safeVerification = Array.isArray(detection?.verificationPlan) && detection.verificationPlan.length
    ? detection.verificationPlan.map((step) => ({ id: step.id, argv: step.argv }))
    : [{ id: "typecheck", argv: ["npm", "run", "typecheck"] }];
  const repo = detection?.repository ?? overrides.repository ?? "owner/repo";
  return {
    schemaVersion: 2,
    profile: "engineering",
    project: {
      remote: detection?.remote ?? "origin",
      repository: repo,
      defaultBranch: detection?.defaultBranch ?? "main",
      packageManager: pm,
      detectOverrides: false,
    },
    delivery: {
      worktree: {
        root: detection?.worktreeRoot ?? ".worktrees",
        branchTemplate: "{actor}/{slug}",
        bootstrap: safeBootstrap,
      },
      verification: {
        commands: safeVerification,
        requireCleanDiffAfter: true,
        invalidateOnHeadChange: true,
      },
      review: { agent: "delivery-reviewer", required: true, invalidateOnHeadChange: true },
      ci: {
        driver: "github-status-checks",
        requiredChecks: ["delivery-verify"],
        wait: true,
        flakyRetry: 1,
      },
      ready: { requires: ["review", "local-verification", "remote-ci"], stopAfterReady: true },
      merge: { strategy: "squash", policy: "explicit-user-request-only", requireFreshGates: true },
      cleanup: { when: "next-task", requireUnpublishedGuard: true },
    },
    workflow: {
      models: {},
      approval: { mirrorToIssue: true, maxFailedRounds: 3 },
    },
  };
}

/**
 * Returns true when the workflow block has all three model roles
 * populated with a valid `<provider>/<model>` id. Used by the ship
 * controller and the doctor to refuse to dispatch.
 */
export function hasCompletedModels(configValue) {
  const models = configValue?.workflow?.models;
  if (!models || typeof models !== "object") return false;
  const idRe = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
  return (
    typeof models.planner === "string" && idRe.test(models.planner) &&
    typeof models.builder === "string" && idRe.test(models.builder) &&
    typeof models.finalReviewer === "string" && idRe.test(models.finalReviewer)
  );
}
