/**
 * JSONC-aware root-config editing.
 *
 * The installer owns a subset of leaves in the consumer's
 * `opencode.json` (or `opencode.jsonc`). Everything else must
 * survive every installer edit byte-for-byte:
 *
 *   - line comments (`// // ... `) and block comments (`/* ... *\/`)
 *   - trailing commas
 *   - key order at every level
 *   - line endings (LF / CRLF)
 *   - indentation (tabs / spaces)
 *   - unrelated keys
 *
 * `jsonc-parser` is the canonical implementation. We apply
 * edits through `modify(text, path, value, options)` and
 * `applyEdits(text, editOps)` so the previous edit's output
 * becomes the next edit's input. The returned bytes are
 * byte-identical to the original when no edits were applied.
 *
 * The package's ESM build (`lib/esm/`) ships with internal
 * imports that omit the `.js` extension, which fails strict
 * ESM resolution. We import the ESM build directly and rely on
 * esbuild's bundling to resolve everything to bundled code
 * paths. The build process patches the missing extensions.
 */

import { modify, applyEdits, parse as jsoncParse } from "jsonc-parser";

export class JsoncEditError extends Error {
  constructor(message, path) {
    super(`${message} (path=${path ?? "<root>"})`);
    this.name = "JsoncEditError";
    this.path = path ?? null;
  }
}

function pointerToPath(pointer) {
  if (typeof pointer !== "string" || pointer.length === 0) return [];
  return pointer.split("/").slice(1).map(decodePointerToken);
}

function decodePointerToken(token) {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

/**
 * Apply the supplied pointer edits to `source` using jsonc-parser.
 * Returns the new bytes. When `edits` is empty, returns
 * `source` byte-for-byte.
 *
 * `edits` is a flat list of { pointer, value, op } entries.
 * `op` is one of:
 *   - "set": write the value at the pointer (creates parents)
 *   - "delete": remove the leaf at the pointer (no-op if absent)
 *
 * jsonc-parser `modify` creates missing parent objects on the
 * fly. We sort the edits by path depth so parents are added
 * before children. The applied edits use a fresh `working`
 * string each step so subsequent edits see the previous edit's
 * output.
 */
export function applyJsoncEdits(source, edits) {
  if (typeof source !== "string") {
    throw new JsoncEditError("source must be a string", null);
  }
  if (!Array.isArray(edits)) {
    throw new JsoncEditError("edits must be an array", null);
  }
  if (edits.length === 0) {
    return Buffer.from(source, "utf8");
  }
  // Sort by path depth so parent paths are applied before
  // children. Stable order preserves the input ordering inside
  // the same depth so the user-supplied diff is deterministic.
  const sorted = [...edits].sort((a, b) => {
    const da = a.pointer.split("/").length;
    const db = b.pointer.split("/").length;
    return da - db;
  });
  let working = source;
  for (const edit of sorted) {
    if (!edit || typeof edit.pointer !== "string" || !edit.pointer.startsWith("/")) {
      throw new JsoncEditError(`invalid pointer ${JSON.stringify(edit?.pointer)}`, edit?.pointer ?? null);
    }
    if (edit.op !== "set" && edit.op !== "delete") {
      throw new JsoncEditError(`invalid op ${edit.op}`, edit.pointer);
    }
    const path = pointerToPath(edit.pointer);
    const value = edit.op === "delete" ? undefined : edit.value;
    let editOps;
    try {
      editOps = modify(working, path, value, {});
    } catch (err) {
      throw new JsoncEditError(`modify failed at ${edit.pointer}: ${err?.message ?? err}`, edit.pointer);
    }
    working = applyEdits(working, editOps);
  }
  const errors = [];
  jsoncParse(working, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new JsoncEditError(`result is not valid JSON: ${errors[0]?.error ?? errors[0]}`, null);
  }
  return Buffer.from(working, "utf8");
}

/**
 * Compute the JSON pointer diff between two parsed objects. The
 * returned edits are the minimum set required to make `before`
 * equal to `after` at the listed pointers. Existing pointer
 * records that already match `after` are omitted (no-op).
 */
export function diffPointers(before, after, pointers) {
  /** @type {Array<{ pointer: string, value?: unknown, op: "set" | "delete" }>} */
  const edits = [];
  for (const pointer of pointers) {
    const prev = readPointer(before, pointer);
    const next = readPointer(after, pointer);
    if (next === undefined) {
      edits.push({ pointer, op: /** @type {"delete"} */ ("delete") });
    } else if (prev === undefined || !stableJsonEqual(prev, next)) {
      edits.push({ pointer, value: next, op: /** @type {"set"} */ ("set") });
    }
  }
  return edits;
}

function readPointer(doc, pointer) {
  if (!doc || typeof doc !== "object") return undefined;
  const tokens = pointer.split("/").slice(1).map(decodePointerToken);
  let cursor = doc;
  for (const tok of tokens) {
    if (cursor === null || cursor === undefined) return undefined;
    cursor = cursor[tok];
  }
  return cursor === undefined ? undefined : cursor;
}

function stableJsonEqual(a, b) {
  return canonicalize(a) === canonicalize(b);
}

function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const out = {};
  const keys = Object.keys(value).sort();
  for (const k of keys) out[k] = canonicalize(value[k]);
  return `{${keys.map((k) => `${JSON.stringify(k)}:${out[k]}`).join(",")}}`;
}
