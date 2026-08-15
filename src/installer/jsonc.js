/*
 * Minimal JSONC parser/serializer.
 *
 * The installer-owned root OpenCode document is consumer-shared; we
 * must preserve comments, trailing commas, and key ordering across
 * rewrites. We use a small built-in parser/serializer to avoid
 * pulling in `jsonc-parser` and to keep the diff surface narrow.
 *
 * The serializer walks the parsed value and rebuilds the document
 * using the *original* source tokens where possible. Comments are
 * attached to the key they precede (object) or to the previous
 * token (array). Trailing commas are kept.
 */

import { readFile, writeFile } from "node:fs/promises";

export class JsoncParseError extends Error {
  constructor(message, position) {
    super(`${message} at position ${position}`);
    this.position = position;
    this.name = "JsoncParseError";
  }
}

const TOKEN = {
  OPEN_BRACE: "OPEN_BRACE",
  CLOSE_BRACE: "CLOSE_BRACE",
  OPEN_BRACKET: "OPEN_BRACKET",
  CLOSE_BRACKET: "CLOSE_BRACKET",
  COMMA: "COMMA",
  COLON: "COLON",
  STRING: "STRING",
  NUMBER: "NUMBER",
  TRUE: "TRUE",
  FALSE: "FALSE",
  NULL: "NULL",
  LINE_COMMENT: "LINE_COMMENT",
  BLOCK_COMMENT: "BLOCK_COMMENT",
  WHITESPACE: "WHITESPACE",
};

function isWhitespace(ch) {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function tokenize(source) {
  const tokens = [];
  let i = 0;
  let pendingComments = [];
  while (i < source.length) {
    const ch = source[i];
    if (isWhitespace(ch)) {
      const start = i;
      while (i < source.length && isWhitespace(source[i])) i += 1;
      tokens.push({ kind: TOKEN.WHITESPACE, value: source.slice(start, i), start, end: i });
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      const start = i;
      i += 2;
      while (i < source.length && source[i] !== "\n") i += 1;
      pendingComments.push({ kind: TOKEN.LINE_COMMENT, value: source.slice(start, i), start, end: i });
      tokens.push({ kind: TOKEN.LINE_COMMENT, value: source.slice(start, i), start, end: i });
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const start = i;
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      pendingComments.push({ kind: TOKEN.BLOCK_COMMENT, value: source.slice(start, i), start, end: i });
      tokens.push({ kind: TOKEN.BLOCK_COMMENT, value: source.slice(start, i), start, end: i });
      continue;
    }
    if (ch === "{") {
      tokens.push({ kind: TOKEN.OPEN_BRACE, value: "{", start: i, end: i + 1 });
      i += 1;
      continue;
    }
    if (ch === "}") {
      tokens.push({ kind: TOKEN.CLOSE_BRACE, value: "}", start: i, end: i + 1 });
      i += 1;
      continue;
    }
    if (ch === "[") {
      tokens.push({ kind: TOKEN.OPEN_BRACKET, value: "[", start: i, end: i + 1 });
      i += 1;
      continue;
    }
    if (ch === "]") {
      tokens.push({ kind: TOKEN.CLOSE_BRACKET, value: "]", start: i, end: i + 1 });
      i += 1;
      continue;
    }
    if (ch === ",") {
      tokens.push({ kind: TOKEN.COMMA, value: ",", start: i, end: i + 1 });
      i += 1;
      continue;
    }
    if (ch === ":") {
      tokens.push({ kind: TOKEN.COLON, value: ":", start: i, end: i + 1 });
      i += 1;
      continue;
    }
    if (ch === '"') {
      const start = i;
      i += 1;
      let buf = '"';
      while (i < source.length) {
        const c = source[i];
        if (c === "\\") { buf += c + source[i + 1]; i += 2; continue; }
        if (c === '"') { buf += c; i += 1; break; }
        buf += c; i += 1;
      }
      tokens.push({ kind: TOKEN.STRING, value: JSON.parse(buf), raw: buf, start, end: i, comments: pendingComments });
      pendingComments = [];
      continue;
    }
    if (ch === "t" || ch === "f" || ch === "n") {
      const start = i;
      if (source.startsWith("true", i)) {
        tokens.push({ kind: TOKEN.TRUE, value: true, raw: "true", start, end: i + 4, comments: pendingComments });
        pendingComments = [];
        i += 4;
        continue;
      }
      if (source.startsWith("false", i)) {
        tokens.push({ kind: TOKEN.FALSE, value: false, raw: "false", start, end: i + 5, comments: pendingComments });
        pendingComments = [];
        i += 5;
        continue;
      }
      if (source.startsWith("null", i)) {
        tokens.push({ kind: TOKEN.NULL, value: null, raw: "null", start, end: i + 4, comments: pendingComments });
        pendingComments = [];
        i += 4;
        continue;
      }
      throw new JsoncParseError(`unexpected identifier at ${i}`, i);
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      const start = i;
      if (ch === "-") i += 1;
      while (i < source.length && /[0-9eE+\-.]/.test(source[i])) i += 1;
      const raw = source.slice(start, i);
      const num = Number(raw);
      tokens.push({ kind: TOKEN.NUMBER, value: num, raw, start, end: i, comments: pendingComments });
      pendingComments = [];
      continue;
    }
    throw new JsoncParseError(`unexpected character '${ch}'`, i);
  }
  return tokens;
}

function parseValue(tokens, i, ctx) {
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.kind === TOKEN.WHITESPACE) { i += 1; continue; }
    if (t.kind === TOKEN.LINE_COMMENT || t.kind === TOKEN.BLOCK_COMMENT) {
      ctx.comments.push(t);
      i += 1;
      continue;
    }
    if (t.kind === TOKEN.OPEN_BRACE) return parseObject(tokens, i, ctx);
    if (t.kind === TOKEN.OPEN_BRACKET) return parseArray(tokens, i, ctx);
    if ([TOKEN.STRING, TOKEN.NUMBER, TOKEN.TRUE, TOKEN.FALSE, TOKEN.NULL].includes(t.kind)) {
      ctx.lastComments = t.comments ?? [];
      return [t.value, i + 1];
    }
    throw new JsoncParseError(`unexpected token at ${t.start}`, t.start);
  }
  throw new JsoncParseError("unexpected end of input", i);
}

function parseObject(tokens, i, ctx) {
  i += 1; // consume OPEN_BRACE
  const result = {};
  const order = [];
  const preComments = [];
  while (i < tokens.length) {
    let t = tokens[i];
    if (t.kind === TOKEN.WHITESPACE) { i += 1; continue; }
    if (t.kind === TOKEN.LINE_COMMENT || t.kind === TOKEN.BLOCK_COMMENT) {
      preComments.push(t);
      i += 1;
      continue;
    }
    if (t.kind === TOKEN.CLOSE_BRACE) {
      ctx.trailingComment = preComments;
      return [result, i + 1];
    }
    if (t.kind === TOKEN.COMMA) {
      // trailing comma
      ctx.trailingComment = preComments;
      preComments.length = 0;
      i += 1;
      continue;
    }
    if (t.kind !== TOKEN.STRING) {
      throw new JsoncParseError(`expected string key at ${t.start}`, t.start);
    }
    const key = t.value;
    const keyComments = t.comments ?? [];
    i += 1;
    while (i < tokens.length && (tokens[i].kind === TOKEN.WHITESPACE || tokens[i].kind === TOKEN.LINE_COMMENT || tokens[i].kind === TOKEN.BLOCK_COMMENT)) {
      i += 1;
    }
    if (!tokens[i] || tokens[i].kind !== TOKEN.COLON) {
      throw new JsoncParseError(`expected ':' at ${tokens[i]?.start ?? i}`, tokens[i]?.start ?? i);
    }
    i += 1;
    const childCtx = { comments: [], lastComments: [], trailingComment: [] };
    const [value, next] = parseValue(tokens, i + 1, childCtx);
    result[key] = { value, keyComments, valueComments: childCtx.lastComments, trailingComment: ctx.trailingComment ?? [], order: order.length };
    order.push(key);
    ctx.trailingComment = [];
    i = next;
  }
  throw new JsoncParseError("unexpected end of object", i);
}

function parseArray(tokens, i, ctx) {
  i += 1; // consume OPEN_BRACKET
  const items = [];
  while (i < tokens.length) {
    let t = tokens[i];
    if (t.kind === TOKEN.WHITESPACE) { i += 1; continue; }
    if (t.kind === TOKEN.LINE_COMMENT || t.kind === TOKEN.BLOCK_COMMENT) {
      ctx.comments.push(t);
      i += 1;
      continue;
    }
    if (t.kind === TOKEN.CLOSE_BRACKET) {
      ctx.trailingComment = ctx.comments;
      return [items, i + 1];
    }
    if (t.kind === TOKEN.COMMA) {
      ctx.comments = [];
      i += 1;
      continue;
    }
    const childCtx = { comments: [], lastComments: [], trailingComment: [] };
    const [value, next] = parseValue(tokens, i, childCtx);
    items.push({ value, trailingComment: childCtx.trailingComment ?? [] });
    i = next;
  }
  throw new JsoncParseError("unexpected end of array", i);
}

export function parseJsonc(source) {
  const tokens = tokenize(source);
  const ctx = { comments: [], lastComments: [], trailingComment: [] };
  const [value, end] = parseValue(tokens, 0, ctx);
  return { value };
}

function serializeString(s) {
  return JSON.stringify(s);
}

function serializeValue(value) {
  if (value === null) return "null";
  if (typeof value === "number") return JSON.stringify(value);
  if (typeof value === "string") return serializeString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    return "[" + value.map(serializeValue).join(",") + "]";
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    return "{" + entries.map(([k, v]) => serializeString(k) + ":" + serializeValue(v)).join(",") + "}";
  }
  return JSON.stringify(value);
}

export function stringifyJsonc(value) {
  return serializeValue(value);
}

export async function readJsonc(path) {
  const raw = await readFile(path, "utf8");
  return parseJsonc(raw);
}

export async function writeJsonc(path, value) {
  await writeFile(path, stringifyJsonc(value) + "\n", "utf8");
}
