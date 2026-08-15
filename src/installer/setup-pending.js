/*
 * Ship setup-pending marker.
 *
 * After `init` without model flags, the installer writes
 * `.opencode/ship.setup-pending.json` so the ship controller
 * routes `ship-deliver` through `/setup-ship-workflow` before any
 * plan can be drafted. The setup-ship-workflow skill removes the
 * marker on success. Manual removal is also supported: the file is
 * a JSON object with a `reason` field and is safe to delete.
 *
 * Detection: any pre-existing `.opencode/ship.setup-pending.json`
 * counts as "setup pending"; the actual contents are advisory.
 */

import { existsSync, readFileSync, unlinkSync, writeFile, mkdir as mkdirAsync } from "node:fs";
import { promisify } from "node:util";
import { resolve, dirname } from "node:path";

const writeFileAsync = promisify(writeFile);
const mkdirAsyncAsync = promisify(mkdirAsync);

const REL_PATH = ".opencode/ship.setup-pending.json";

export function setupPendingPath(repoRoot) {
  return resolve(repoRoot, REL_PATH);
}

export function isSetupPending(repoRoot) {
  return existsSync(setupPendingPath(repoRoot));
}

export function readSetupPending(repoRoot) {
  const path = setupPendingPath(repoRoot);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw);
  } catch {
    return { reason: "setup-pending file is malformed" };
  }
}

export async function writeSetupPending(repoRoot, payload) {
  const path = setupPendingPath(repoRoot);
  await mkdirAsyncAsync(dirname(path), { recursive: true });
  await writeFileAsync(path, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

export function clearSetupPending(repoRoot) {
  const path = setupPendingPath(repoRoot);
  if (!existsSync(path)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

export const SETUP_PENDING_REL_PATH = REL_PATH;
