/**
 * Immutable abandon intent and completion store.
 *
 * Records live under
 * `<git-common-dir>/opencode-ship/delivery/abandoned/<taskId>/`
 * so primary checkouts and linked worktrees share one audit trail.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { resolveGitCommonDir } from "./git-common-dir.js";
import { publishImmutableJson } from "./durable-store.js";
import { canonicalJson } from "../installer/json-pointer.js";

const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

function abandonDir(commonDir, taskId) {
  return join(commonDir, "opencode-ship", "delivery", "abandoned", taskId);
}

function intentPathFor(commonDir, taskId) {
  return join(abandonDir(commonDir, taskId), "intent.json");
}

function completionPathFor(commonDir, taskId) {
  return join(abandonDir(commonDir, taskId), "completion.json");
}

async function readJsonOrNull(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

function withoutIntentHash(record) {
  const copy = { ...(record ?? {}) };
  delete copy.intentHash;
  return copy;
}

export function hashAbandonIntent(record) {
  return createHash("sha256").update(canonicalJson(withoutIntentHash(record)), "utf8").digest("hex");
}

export async function readAbandon(repoRoot, taskId) {
  const commonDir = await resolveGitCommonDir(repoRoot);
  if (!SAFE_ID_RE.test(String(taskId ?? ""))) {
    return { intent: null, completion: null };
  }
  return {
    intent: await readJsonOrNull(intentPathFor(commonDir, taskId)),
    completion: await readJsonOrNull(completionPathFor(commonDir, taskId)),
  };
}

async function publishOrReuse(path, record) {
  try {
    await publishImmutableJson(path, record);
    return { ok: true, record, idempotent: false };
  } catch (err) {
    const message = String(err?.message ?? err);
    if (!message.includes("already exists")) throw err;
    const existing = await readJsonOrNull(path);
    if (existing && canonicalJson(existing) === canonicalJson(record)) {
      return { ok: true, record: existing, idempotent: true };
    }
    return { ok: false, kind: "abandon-conflict" };
  }
}

export async function publishAbandonIntent(repoRoot, record) {
  const taskId = String(record?.taskId ?? "");
  if (!SAFE_ID_RE.test(taskId)) {
    return { ok: false, kind: "invalid-task-id" };
  }
  const sealed = { ...withoutIntentHash(record), intentHash: hashAbandonIntent(record) };
  const commonDir = await resolveGitCommonDir(repoRoot);
  return publishOrReuse(intentPathFor(commonDir, taskId), sealed);
}

export async function publishAbandonCompletion(repoRoot, record) {
  const taskId = String(record?.taskId ?? "");
  const intentHash = String(record?.intentHash ?? "");
  if (!SAFE_ID_RE.test(taskId)) {
    return { ok: false, kind: "invalid-task-id" };
  }
  if (!HASH_RE.test(intentHash)) {
    return { ok: false, kind: "invalid-intent-hash" };
  }
  const commonDir = await resolveGitCommonDir(repoRoot);
  return publishOrReuse(completionPathFor(commonDir, taskId), record);
}
