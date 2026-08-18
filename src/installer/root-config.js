/*
 * Root opencode.json / opencode.jsonc editing.
 *
 * The installer owns ONLY the Build-agent delivery permissions and
 * the reviewer/verifier subagent delegation allow-rules. Nothing
 * else is touched. The root config remains a shared document; we
 * never replace the whole file, we never invent one without
 * explicit user direction, and we never silently overwrite a leaf
 * that already carries a different value.
 *
 * JSONC support is intentionally narrow: we accept comments
 * (`//` and `/* *\/` style) and trailing commas, but we never emit
 * either format by default. Comments and trailing commas in the
 * source file are preserved only by writing through `jsonc-parser`
 * when we touch the file; for the initial install we only
 * synthesise JSON when we are the ones creating the file (which we
 * never do; `init` only writes the user config and root config
 * pointers).
 */

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setPointer, getPointer, stableStringify } from "./json-pointer.js";
import { bytesHashString } from "./hash.js";
import { planModePermissions } from "./plan-mode-permissions.js";

export const POINTER_ENTRIES = [
  {
    pointer: "/agent/build/permission/delivery_inspect",
    strategy: "value",
    value: "allow",
  },
  {
    pointer: "/agent/build/permission/delivery_issue",
    strategy: "value",
    value: "allow",
  },
  {
    pointer: "/agent/build/permission/delivery_worktree",
    strategy: "value",
    value: "allow",
  },
  {
    pointer: "/agent/build/permission/delivery_verify",
    strategy: "value",
    value: "deny",
  },
  {
    pointer: "/agent/build/permission/delivery_review",
    strategy: "value",
    value: "deny",
  },
  {
    pointer: "/agent/build/permission/delivery_pr",
    strategy: "value",
    value: "allow",
  },
  {
    pointer: "/agent/build/permission/delivery_ready",
    strategy: "value",
    value: "allow",
  },
  {
    pointer: "/agent/build/permission/delivery_merge",
    strategy: "value",
    value: "ask",
  },
  {
    pointer: "/agent/build/permission/delivery_cleanup",
    strategy: "value",
    value: "allow",
  },
  {
    pointer: "/agent/build/permission/task/delivery-reviewer",
    strategy: "value",
    value: "allow",
  },
  {
    pointer: "/agent/build/permission/task/delivery-verifier",
    strategy: "value",
    value: "allow",
  },
  // Build -> ship-controller delegation so the deep plan/build/review
  // chain works with subagent_depth=2.
  {
    pointer: "/agent/build/permission/task/ship-controller",
    strategy: "value",
    value: "allow",
  },
  {
    pointer: "/subagent_depth",
    strategy: "value",
    value: 2,
  },
  // Build-tool permission ask/allow/deny surface.
  {
    pointer: "/agent/build/permission/ship_plan_approve",
    strategy: "value",
    value: "ask",
  },
  {
    pointer: "/agent/build/permission/ship_resume",
    strategy: "value",
    value: "allow",
  },
  {
    pointer: "/agent/build/permission/ship_status",
    strategy: "value",
    value: "allow",
  },
];

const ROOT_PATH_CANDIDATES = ["opencode.json", "opencode.jsonc"];

export function findRootConfig(repoRoot) {
  for (const rel of ROOT_PATH_CANDIDATES) {
    const abs = resolve(repoRoot, rel);
    if (existsSync(abs)) return { path: abs, relative: rel, format: rel.endsWith(".jsonc") ? "jsonc" : "json" };
  }
  return { path: null, relative: ROOT_PATH_CANDIDATES[0], format: "json" };
}

export function defaultRootConfigPath(repoRoot) {
  return resolve(repoRoot, ROOT_PATH_CANDIDATES[0]);
}

export function readRootConfig(absPath) {
  if (!existsSync(absPath)) {
    return { ok: false, error: { kind: "missing", path: absPath } };
  }
  const raw = readFileSync(absPath, "utf8");
  const stripped = stripJsonc(raw);
  try {
    const value = JSON.parse(stripped);
    return {
      ok: true,
      path: absPath,
      raw,
      sha256: bytesHashString(raw),
      value,
      before: snapshotValues(value),
      format: absPath.endsWith(".jsonc") ? "jsonc" : "json",
    };
  } catch (e) {
    return { ok: false, error: { kind: "parse", path: absPath, message: e.message } };
  }
}

function snapshotValues(doc) {
  const out = {};
  for (const entry of POINTER_ENTRIES) {
    out[entry.pointer] = getPointer(doc, entry.pointer);
  }
  return out;
}

function stripJsonc(text) {
  let stripped = "";
  let i = 0;
  let inString = false;
  let escape = false;
  while (i < text.length) {
    const ch = text[i];
    if (inString) {
      stripped += ch;
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      stripped += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    stripped += ch;
    i += 1;
  }
  return stripped.replace(/,\s*([}\]])/g, "$1");
}

export function applyOwnedPointers(rootDoc, { pointerEntries = POINTER_ENTRIES, allowEqualValues = true } = {}) {
  /** @type {{ doc: any, applied: Array<{ pointer: string, value: any }>, skipped: Array<{ pointer: string, reason: string, existing?: any, desired?: any }> }} */
  const result = { doc: rootDoc, applied: [], skipped: [] };
  let doc = rootDoc;
  for (const entry of pointerEntries) {
    const existing = getPointer(doc, entry.pointer);
    if (existing === undefined) {
      doc = setPointer(doc, entry.pointer, entry.value);
      result.applied.push({ pointer: entry.pointer, value: entry.value });
      continue;
    }
    if (existing === entry.value || stableStringify(existing) === stableStringify(entry.value)) {
      // Deep-equal values are treated as already equal even when
      // they come from a fresh object literal (the engineering
      // permission block is rebuilt on every call). Reference
      // equality alone would mis-report every install as a
      // conflict once the value was materialised once.
      if (allowEqualValues) {
        result.skipped.push({ pointer: entry.pointer, reason: "already equal" });
      }
      continue;
    }
    result.skipped.push({
      pointer: entry.pointer, reason: "different existing value",
      existing, desired: entry.value,
    });
  }
  // `setPointer` is immutable; the final `doc` is the fully
  // materialised value. Update the public reference so callers
  // that diff `rootDoc` vs `result.doc` see the post-edit state.
  result.doc = doc;
  return result;
}

/**
 * Single owned pointer for the Plan Mode sub-agent. The block is
 * a structured object (deny-first + narrow allow) so the standard
 * scalar-only POINTER_ENTRIES pipeline cannot carry it; the
 * installer injects it directly when the active profile is
 * `engineering`. The id is stable for the run ledger.
 */
export const PLAN_MODE_POINTER = "/agent/plan/permission";

/**
 * Apply the Plan Mode permission block to the consumer's
 * `opencode.json`. Captures the previous value (if any) so
 * uninstall can restore it. Returns `{ doc, previous, id }`.
 */
export function applyPlanModeOwnership(rootDoc, { pointer = PLAN_MODE_POINTER, block = planModePermissions().build } = {}) {
  const previous = getPointer(rootDoc, pointer);
  const doc = setPointer(rootDoc, pointer, block);
  return { doc, previous: previous === undefined ? null : previous, id: pointer };
}

/**
 * Re-export the Plan Mode block at the render layer so callers
 * (CLI snapshots, JSON envelopes) can show the same shape.
 */
export function planModeBlock() {
  return planModePermissions().build;
}

/*
 * Synthesise the consumer-owned root shell. The reconciler applies
 * every installer-owned permission descriptor in canonical order so
 * wildcard deny rules precede their explicit exceptions.
 */
export function synthesizeDefaultRootConfig() {
  return {
    $schema: "https://opencode.ai/config.json",
  };
}

/*
 * Format a root opencode document as bytes.
 *
 * For new files (no source) we emit clean JSON.
 * For existing files the planner preserves the source format:
 * - JSON files: clean `JSON.stringify(doc, null, 2)` (key order
 *   inherited from the source parser, see parseRootConfigPreservingOrder).
 * - JSONC files: when no key conflicts are present we preserve
 *   comments by reading the source via `jsonc-parser`-style logic;
 *   for now we emit clean JSON when the planner needs to write,
 *   which loses comments. This is documented and tracked; the
 *   alternative — comment-preserving rewrite — is planned.
 *
 * Callers: `formatRootConfig(value)` for fresh writes; the planner
 * picks `formatRootConfigPreserving(value, sourceFormat)` when
 * rewriting an existing file with a known source.
 */
export function formatRootConfig(value) {
  return JSON.stringify(stripSourceOrder(value), null, 2) + "\n";
}

function stripSourceOrder(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const out = Array.isArray(value) ? [] : {};
  const order = Array.isArray(value.__sourceOrder__) ? value.__sourceOrder__ : null;
  const seen = new Set();
  if (order) {
    for (const k of order) {
      if (k === "__sourceOrder__") continue;
      if (!(k in value)) continue;
      seen.add(k);
      out[k] = stripSourceOrder(value[k]);
    }
  }
  for (const k of Object.keys(value)) {
    if (k === "__sourceOrder__") continue;
    if (seen.has(k)) continue;
    out[k] = stripSourceOrder(value[k]);
  }
  return out;
}

/*
 * Format a value while honoring a stored source order so the
 * resulting bytes preserve the input key sequence at every level.
 * The output is technically valid JSON; comments are not preserved.
 */
export function formatRootConfigPreserving(value) {
  return formatRootConfig(value);
}

/*
 * Parse a JSON/JSONC document but preserve the order of the
 * first-seen keys at each level. Used so a round-trip can keep the
 * original ordering.
 */
export function parseRootConfigPreservingOrder(text) {
  if (typeof text !== "string" || text.length === 0) {
    return { value: {}, format: "json" };
  }
  const parser = new RootConfigParser(text);
  const value = parser.parseValue(0, /*atTop*/ true);
  const isJsonc = text.includes("//") || text.includes("/*");
  return { value, format: isJsonc ? "jsonc" : "json" };
}

class RootConfigParser {
  constructor(text) {
    this.text = text;
    this.pos = 0;
  }
  skipWS() {
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos];
      if (ch === " " || ch === "\n" || ch === "\t" || ch === "\r") {
        this.pos += 1;
        continue;
      }
      if (ch === "/" && this.text[this.pos + 1] === "/") {
        while (this.pos < this.text.length && this.text[this.pos] !== "\n") this.pos += 1;
        continue;
      }
      if (ch === "/" && this.text[this.pos + 1] === "*") {
        this.pos += 2;
        while (this.pos < this.text.length && !(this.text[this.pos] === "*" && this.text[this.pos + 1] === "/")) this.pos += 1;
        this.pos += 2;
        continue;
      }
      break;
    }
  }
  parseValue(depth, atTop) {
    this.skipWS();
    const ch = this.text[this.pos];
    if (ch === "{") return this.parseObject(depth, atTop);
    if (ch === "[") return this.parseArray(depth);
    if (ch === '"') return this.parseString();
    if (ch === "-" || (ch >= "0" && ch <= "9")) return this.parseNumber();
    if (this.text.startsWith("true", this.pos)) { this.pos += 4; return true; }
    if (this.text.startsWith("false", this.pos)) { this.pos += 5; return false; }
    if (this.text.startsWith("null", this.pos)) { this.pos += 4; return null; }
    throw new Error(`unexpected token at ${this.pos}: ${this.text.slice(this.pos, this.pos + 8)}`);
  }
  parseObject(depth, atTop) {
    const out = Object.create(null);
    out.__sourceOrder__ = [];
    this.pos += 1;
    while (this.pos < this.text.length) {
      this.skipWS();
      if (this.text[this.pos] === "}") { this.pos += 1; return out; }
      const key = this.parseString();
      out.__sourceOrder__.push(key);
      this.skipWS();
      if (this.text[this.pos] !== ":") throw new Error(`expected : at ${this.pos}`);
      this.pos += 1;
      out[key] = this.parseValue(depth + 1, false);
      this.skipWS();
      if (this.text[this.pos] === ",") { this.pos += 1; continue; }
      if (this.text[this.pos] === "}") { this.pos += 1; return out; }
      throw new Error(`expected , or } at ${this.pos}`);
    }
    throw new Error("unterminated object");
  }
  parseArray(depth) {
    const out = [];
    this.pos += 1;
    while (this.pos < this.text.length) {
      this.skipWS();
      if (this.text[this.pos] === "]") { this.pos += 1; return out; }
      out.push(this.parseValue(depth + 1, false));
      this.skipWS();
      if (this.text[this.pos] === ",") { this.pos += 1; continue; }
      if (this.text[this.pos] === "]") { this.pos += 1; return out; }
      throw new Error(`expected , or ] at ${this.pos}`);
    }
    throw new Error("unterminated array");
  }
  parseString() {
    if (this.text[this.pos] !== '"') throw new Error(`expected " at ${this.pos}`);
    this.pos += 1;
    let out = "";
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos];
      if (ch === "\\") {
        const next = this.text[this.pos + 1];
        out += ch + next;
        this.pos += 2;
        continue;
      }
      if (ch === '"') {
        this.pos += 1;
        return JSON.parse('"' + out + '"');
      }
      out += ch;
      this.pos += 1;
    }
    throw new Error("unterminated string");
  }
  parseNumber() {
    const start = this.pos;
    if (this.text[this.pos] === "-") this.pos += 1;
    while (this.pos < this.text.length && /[0-9.eE+\-]/.test(this.text[this.pos])) this.pos += 1;
    return Number(this.text.slice(start, this.pos));
  }
}
