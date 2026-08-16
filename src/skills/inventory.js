/**
 * Skill inventory.
 *
 * Records every trusted skill installed through the typed
 * `ship_skill_install` tool. The inventory is stored under
 * the consumer repo (NOT Git common dir) so the lockfile
 * travels with the repo and is reviewable on the PR.
 *
 * The inventory is hash-chained: each entry carries the
 * SHA-256 of the previous entry's canonical bytes plus its
 * own, so a tampered or reordered inventory is detectable
 * through replay.
 */
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";

const INVENTORY_PATH = ".opencode/ship.skills.lock.json";

export function inventoryPath(repoRoot) {
  return resolve(repoRoot, INVENTORY_PATH);
}

export async function readInventory(repoRoot) {
  const path = inventoryPath(repoRoot);
  if (!existsSync(path)) {
    return { schemaVersion: 1, entries: [] };
  }
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { schemaVersion: 1, entries: [] };
    }
    if (!Array.isArray(parsed.entries)) parsed.entries = [];
    if (!Number.isInteger(parsed.schemaVersion)) parsed.schemaVersion = 1;
    return parsed;
  } catch {
    return { schemaVersion: 1, entries: [] };
  }
}

export async function writeInventory(repoRoot, inventory) {
  const path = inventoryPath(repoRoot);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${Date.now().toString(36)}.tmp`;
  await writeFile(tmp, JSON.stringify(inventory, null, 2) + "\n", "utf8");
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

export function hashEntry(entry) {
  return createHash("sha256").update(canonicalize(entry), "utf8").digest("hex");
}

export async function appendEntry(repoRoot, entry) {
  const inventory = await readInventory(repoRoot);
  const previousHash = inventory.entries.length > 0
    ? inventory.entries[inventory.entries.length - 1].hash
    : "0".repeat(64);
  const stamped = {
    ...entry,
    sequence: inventory.entries.length + 1,
    previousHash,
    recordedAt: new Date().toISOString(),
  };
  stamped.hash = hashEntry({ ...stamped, hash: undefined });
  inventory.entries.push(stamped);
  await writeInventory(repoRoot, inventory);
  return stamped;
}

export async function verifyInventory(repoRoot) {
  const inventory = await readInventory(repoRoot);
  let prev = "0".repeat(64);
  for (const entry of inventory.entries) {
    if (entry.previousHash !== prev) {
      return { ok: false, reason: "chain-break", entry: entry.sequence };
    }
    const recomputed = hashEntry({ ...entry, hash: undefined });
    if (recomputed !== entry.hash) {
      return { ok: false, reason: "hash-mismatch", entry: entry.sequence };
    }
    prev = entry.hash;
  }
  return { ok: true, count: inventory.entries.length };
}
