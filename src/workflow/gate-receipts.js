import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "../installer/json-pointer.js";
import { resolveGitCommonDir, opencodeShipStateDir } from "../state/git-common-dir.js";
import { publishImmutableJson } from "../state/durable-store.js";

const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const HEAD_RE = /^[0-9a-f]{40}$/;

function validateIdentity(taskId, kind, headSha, receiptHash = null) {
  if (!SAFE_ID_RE.test(taskId) || !SAFE_ID_RE.test(kind) || !HEAD_RE.test(headSha)) {
    throw new Error("invalid gate receipt identity");
  }
  if (receiptHash !== null && !HASH_RE.test(receiptHash)) throw new Error("invalid gate receipt hash");
}

export function hashGateReceipt(receipt) {
  const { receiptHash: _receiptHash, ...payload } = receipt;
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

export async function publishGateReceipt(repoRoot, taskId, kind, input) {
  validateIdentity(taskId, kind, input?.headSha);
  const receipt = { ...input, kind, taskId };
  receipt.receiptHash = hashGateReceipt(receipt);
  const commonDir = await resolveGitCommonDir(repoRoot);
  const dir = join(opencodeShipStateDir(commonDir), "gate-receipts", taskId, kind, receipt.headSha);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${receipt.receiptHash}.json`);
  if (!existsSync(path)) await publishImmutableJson(path, receipt);
  return { receipt, path };
}

export async function readGateReceipt(repoRoot, taskId, kind, receiptHash) {
  if (!SAFE_ID_RE.test(taskId) || !SAFE_ID_RE.test(kind) || !HASH_RE.test(receiptHash)) {
    throw new Error("invalid gate receipt lookup");
  }
  const commonDir = await resolveGitCommonDir(repoRoot);
  const root = join(opencodeShipStateDir(commonDir), "gate-receipts", taskId, kind);
  if (!existsSync(root)) return null;
  const { readdir } = await import("node:fs/promises");
  for (const head of await readdir(root)) {
    validateIdentity(taskId, kind, head, receiptHash);
    const path = join(root, head, `${receiptHash}.json`);
    if (!existsSync(path)) continue;
    const receipt = JSON.parse(await readFile(path, "utf8"));
    if (receipt.kind !== kind || receipt.taskId !== taskId || hashGateReceipt(receipt) !== receipt.receiptHash) {
      throw new Error(`invalid ${kind} gate receipt`);
    }
    return receipt;
  }
  return null;
}
