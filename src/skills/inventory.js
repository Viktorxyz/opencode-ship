/**
 * Skill inventory (v2).
 *
 * Records every trusted skill installed through the typed
 * `ship_skill_install` tool. The inventory is stored under
 * the consumer repo (NOT Git common dir) so the lockfile
 * travels with the repo and is reviewable on the PR.
 *
 * The inventory is an append-only hash-chained event log. Every
 * install or uninstall event carries:
 *
 *   - sequence (monotonic integer),
 *   - type ("install" | "uninstall"),
 *   - previousHash (sha256 of the prior event's canonical bytes,
 *     "0"*64 for the first event),
 *   - hash (sha256 of this event's canonical bytes excluding the
 *     `hash` field),
 *   - source (registry provenance: repository + commit + registryId
 *     + registry snapshot hash),
 *   - destination (relative POSIX path under the worktree, never
 *     absolute),
 *   - files (every installed/removed file with its own sha256),
 *   - recordedAt.
 *
 * A tampered or reordered inventory is detected by replaying the
 * chain. The first event with a broken link identifies the
 * tampering point.
 *
 * Uninstall appends an uninstall event referencing the install's
 * hash. It does NOT splice the install out of the chain.
 */
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname, isAbsolute } from "node:path";
import { createHash } from "node:crypto";

export const INVENTORY_PATH = ".opencode/ship.skills.lock.json";
export const INVENTORY_SCHEMA = 2;

export function inventoryPath(repoRoot) {
  return resolve(repoRoot, INVENTORY_PATH);
}

/**
 * Read the inventory from disk. Parse errors and malformed chains
 * fail closed: a malformed inventory is treated as a structural
 * conflict, not an empty one. The installer must explicitly
 * resolve the corruption before subsequent installs.
 *
 * @param {string} repoRoot
 * @returns {Promise<{ schemaVersion: number, events: any[], parseError?: string, chainBreak?: { sequence: number, reason: string } }>}
 */
export async function readInventory(repoRoot) {
  const path = inventoryPath(repoRoot);
  if (!existsSync(path)) {
    return { schemaVersion: INVENTORY_SCHEMA, events: [] };
  }
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    return { schemaVersion: INVENTORY_SCHEMA, events: [], parseError: `read failed: ${err?.message ?? err}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { schemaVersion: INVENTORY_SCHEMA, events: [], parseError: `malformed JSON: ${err?.message ?? err}` };
  }
  if (!parsed || typeof parsed !== "object") {
    return { schemaVersion: INVENTORY_SCHEMA, events: [], parseError: "inventory root is not an object" };
  }
  if (!Array.isArray(parsed.events)) {
    return { schemaVersion: INVENTORY_SCHEMA, events: [], parseError: "inventory.events is not an array" };
  }
  if (parsed.schemaVersion !== INVENTORY_SCHEMA) {
    return {
      schemaVersion: parsed.schemaVersion,
      events: [],
      parseError: `unsupported inventory schemaVersion ${parsed.schemaVersion} (expected ${INVENTORY_SCHEMA})`,
    };
  }
  return { schemaVersion: INVENTORY_SCHEMA, events: parsed.events };
}

export async function writeInventory(repoRoot, inventory) {
  const path = inventoryPath(repoRoot);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${Date.now().toString(36)}.tmp`;
  await writeFile(tmp, JSON.stringify({ schemaVersion: INVENTORY_SCHEMA, events: inventory.events }, null, 2) + "\n", "utf8");
  await rename(tmp, path);
  return path;
}

export function canonicalize(value) {
  const seen = new WeakSet();
  const sort = (v) => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v)) return null;
    seen.add(v);
    if (Array.isArray(v)) return v.map(sort);
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sort(v[k]);
    return out;
  };
  return JSON.stringify(sort(value));
}

export function hashEvent(event) {
  return createHash("sha256").update(canonicalize(event), "utf8").digest("hex");
}

/**
 * Append a new event to the inventory. Returns the recorded event
 * with its computed hash. Caller is responsible for verifying the
 * chain before calling this.
 */
export async function appendEvent(repoRoot, eventInput) {
  const inventory = await readInventory(repoRoot);
  const previousHash = inventory.events.length > 0
    ? inventory.events[inventory.events.length - 1].hash
    : "0".repeat(64);
  const sequence = inventory.events.length + 1;
  // Validate destination is relative POSIX.
  if (eventInput.destination && isAbsolute(eventInput.destination)) {
    throw new Error(`inventory refuses absolute destination: ${eventInput.destination}`);
  }
  const base = {
    sequence,
    type: eventInput.type,
    previousHash,
    recordedAt: new Date().toISOString(),
  };
  // Build the event without the `hash` field; sort canonicalize
  // produces a stable hash for the rest of the payload.
  const payload = { ...base, ...eventInput.payload };
  // Strip any caller-supplied hash so it cannot be spoofed.
  delete payload.hash;
  const stamped = { ...payload, hash: hashEvent(payload) };
  inventory.events.push(stamped);
  await writeInventory(repoRoot, inventory);
  return stamped;
}

/**
 * Replay the inventory chain and report any break. Returns
 * `{ ok: true, count }` on success or
 * `{ ok: false, reason, sequence }` on the first failed event.
 */
export async function verifyInventory(repoRoot) {
  const inventory = await readInventory(repoRoot);
  if (inventory.parseError) {
    return { ok: false, reason: inventory.parseError };
  }
  if (inventory.events.length === 0) return { ok: true, count: 0 };
  let prev = "0".repeat(64);
  for (const ev of inventory.events) {
    if (ev.sequence !== inventory.events.indexOf(ev) + 1) {
      return { ok: false, reason: "sequence-gap", sequence: ev.sequence };
    }
    if (ev.previousHash !== prev) {
      return { ok: false, reason: "chain-break", sequence: ev.sequence };
    }
    const { hash: _h, ...rest } = ev;
    const recomputed = hashEvent(rest);
    if (recomputed !== ev.hash) {
      return { ok: false, reason: "hash-mismatch", sequence: ev.sequence };
    }
    prev = ev.hash;
  }
  return { ok: true, count: inventory.events.length };
}

/**
 * Find the most recent install event for `skillName`. The
 * inventory is chain-ordered; we walk from the tail and pick the
 * first install with that name. If an uninstall exists after the
 * install, the skill is considered not installed.
 *
 * @param {string} repoRoot
 * @param {string} skillName
 */
export async function findActiveInstall(repoRoot, skillName) {
  const inventory = await readInventory(repoRoot);
  const chain = await verifyInventory(repoRoot);
  if (!chain.ok) {
    return { ok: false, reason: chain.reason };
  }
  for (let i = inventory.events.length - 1; i >= 0; i--) {
    const ev = inventory.events[i];
    if (ev.type === "uninstall" && ev.skill === skillName) {
      return { ok: true, install: null, uninstallHash: ev.hash };
    }
    if (ev.type === "install" && ev.skill === skillName) {
      return { ok: true, install: ev, uninstallHash: null };
    }
  }
  return { ok: true, install: null, uninstallHash: null };
}
