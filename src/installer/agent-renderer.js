/*
 * opencode-ship agent renderer.
 *
 * The shipped workflow agent templates do not carry hardcoded
 * `model:` values. The installer fills them in at install / update
 * time from `ship.config.json#workflow.models` so the consumer can
 * pick any `<provider>/<model>` pair the provider credentials can
 * reach. The mapping is fixed:
 *
 *   planner         -> ship-planner
 *   builder         -> ship-controller, ship-task-builder,
 *                      ship-task-reviewer
 *   finalReviewer   -> ship-final-standards-reviewer,
 *                      ship-final-spec-reviewer
 *
 * The legacy `delivery-reviewer` and `delivery-verifier` agents
 * stay model-neutral so consumers can drive them with any model
 * that respects the delivery contract.
 *
 * Rendered bytes are what the lock hash pins, so the catalog
 * template hashes are decoupled from the consumer-side agent
 * frontmatter.
 */

import { dirname, join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { bytesHashString } from "./hash.js";

const MODEL_FROM_CONFIG = "<model-from-config>";

export const AGENT_ROLE_MAP = Object.freeze({
  planner: ["ship-planner"],
  builder: ["ship-controller", "ship-task-builder", "ship-task-reviewer"],
  finalReviewer: ["ship-final-standards-reviewer", "ship-final-spec-reviewer"],
});

export function MODEL_PLACEHOLDER() {
  return MODEL_FROM_CONFIG;
}

/**
 * Replace the `<model-from-config>` placeholder in an agent
 * frontmatter block with the configured model id.
 */
export function renderAgentFrontmatter(source, model) {
  if (typeof source !== "string") return source;
  if (typeof model !== "string" || !model) return source;
  return source.replaceAll(MODEL_FROM_CONFIG, model);
}

/**
 * Compute the rendered bytes and sha256 for every workflow agent
 * the installer should write for the consumer.
 *
 * Returns an array of `{ relPath, bytes, sha256, role, agentName }`
 * for each rendered agent. The caller hands these to the
 * transaction layer instead of the catalog template bytes, and
 * the lock pins the rendered sha256 so model updates track
 * correctly.
 */
export async function computeRenderedAgents({ models, catalog }) {
  const out = [];
  if (!models || typeof models !== "object") return out;
  for (const [role, agentNames] of Object.entries(AGENT_ROLE_MAP)) {
    const model = models[role];
    if (typeof model !== "string" || !model) continue;
    for (const agentName of agentNames) {
      const entry = (catalog ?? []).find((c) => c.kind === "agent" && c.path.endsWith(`/${agentName}.md`));
      if (!entry) continue;
      const source = await readFile(entry.source, "utf8");
      const renderedText = renderAgentFrontmatter(source, model);
      const bytes = Buffer.from(renderedText, "utf8");
      const sha256 = bytesHashString(renderedText);
      out.push({ relPath: entry.path, bytes, sha256, role, agentName, target: join(process.cwd(), entry.path) });
    }
  }
  return out;
}

/**
 * Build a lookup from `relPath` -> rendered bytes/sha256 for use
 * by the planner when computing the install plan. The plan layer
 * prefers the rendered bytes over the catalog template bytes so
 * the locked sha256 reflects what the consumer actually has on
 * disk.
 */
export async function buildRenderedOverride({ models, catalog }) {
  const rendered = await computeRenderedAgents({ models, catalog });
  const map = new Map();
  for (const entry of rendered) {
    map.set(entry.relPath, entry);
  }
  return { rendered, map };
}

/**
 * Compute the rendered model snapshot for a single agent name.
 *
 * Used by tests to compare the frontmatter content without
 * touching the filesystem.
 */
export function renderedModelFor({ agentName, models }) {
  for (const [role, agentNames] of Object.entries(AGENT_ROLE_MAP)) {
    if (agentNames.includes(agentName)) {
      const m = models?.[role];
      return typeof m === "string" && m ? m : MODEL_FROM_CONFIG;
    }
  }
  return MODEL_FROM_CONFIG;
}

void mkdir;
void writeFile;
void dirname;
