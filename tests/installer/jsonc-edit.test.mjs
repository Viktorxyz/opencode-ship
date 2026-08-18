/**
 * JSONC preservation tests.
 *
 * The 1.1.2-rc.2 installer used a custom JSON-stripping parser
 * and `formatRootConfigPreserving`, which dropped comments and
 * trailing commas on every install. These tests pin the byte-
 * safe JSONC contract:
 *
 *   - empty edit set returns the source byte-for-byte
 *   - line comments and block comments survive every installer edit
 *   - trailing commas survive every installer edit
 *   - unrelated keys and their original ordering survive
 *   - line endings (LF / CRLF) survive
 *   - tabs and spaces survive
 *   - a `set` edit at a fresh path creates the parent objects
 *   - a `delete` edit removes the leaf and preserves the rest
 */

import test from "node:test";
import assert from "node:assert/strict";

import { applyJsoncEdits, diffPointers } from "../../src/installer/jsonc-edit.js";
import { parse as jsoncParse } from "jsonc-parser";

test("empty edit set returns the source byte-for-byte", () => {
  const src = `{
  // a comment
  "x": 1,
  "y": [
    "a",
    "b", // trailing comma allowed
  ],
}
`;
  const out = applyJsoncEdits(src, []);
  assert.equal(out.toString("utf8"), src);
});

test("line comments and block comments survive a set edit", () => {
  const src = `{
  // top comment
  "x": 1, /* inline block */
  "y": 2,
  // trailing comment
}
`;
  const out = applyJsoncEdits(src, [
    { pointer: "/x", value: 42, op: "set" },
  ]);
  const text = out.toString("utf8");
  assert.match(text, /\/\/ top comment/);
  assert.match(text, /\/\* inline block \*\//);
  assert.match(text, /\/\/ trailing comment/);
  assert.match(text, /"x":\s*42/);
  assert.match(text, /"y":\s*2/);
});

test("trailing commas survive a set edit", () => {
  const src = `{
  "x": 1,
  "y": 2,
}
`;
  const out = applyJsoncEdits(src, [
    { pointer: "/x", value: 99, op: "set" },
  ]);
  const text = out.toString("utf8");
  assert.match(text, /"x":\s*99,\s*\n\s*"y":\s*2,\s*\n\}/);
});

test("RFC 6901 escaped pointer segments address keys containing slashes", () => {
  const source = "{\n  \"permission\": {}\n}\n";
  const bytes = applyJsoncEdits(source, [{
    pointer: "/permission/rm -rf ~1*",
    value: "deny",
    op: "set",
  }]);
  const parsed = jsoncParse(bytes.toString("utf8"), undefined, { allowTrailingComma: true });
  assert.equal(parsed.permission["rm -rf /*"], "deny");
  assert.equal(parsed.permission["rm -rf ~1*"], undefined);
});

test("unrelated keys and ordering survive a set edit", () => {
  const src = `{
  "first": 1,
  "second": 2,
  "third": 3
}
`;
  const out = applyJsoncEdits(src, [
    { pointer: "/second", value: 20, op: "set" },
  ]);
  const text = out.toString("utf8");
  const firstAt = text.indexOf("first");
  const secondAt = text.indexOf("second");
  const thirdAt = text.indexOf("third");
  assert.ok(firstAt < secondAt);
  assert.ok(secondAt < thirdAt);
  assert.match(text, /"second":\s*20/);
});

test("CRLF line endings survive a set edit", () => {
  const src = '{\r\n  "x": 1,\r\n  "y": 2\r\n}\r\n';
  const out = applyJsoncEdits(src, [
    { pointer: "/x", value: 7, op: "set" },
  ]);
  assert.match(out.toString("utf8"), /\r\n/);
  assert.match(out.toString("utf8"), /"x":\s*7/);
});

test("tabs and spaces are preserved verbatim", () => {
  const src = '{\n\t"x":\t1,\n  "y": 2,\n}\n';
  const out = applyJsoncEdits(src, [
    { pointer: "/x", value: 5, op: "set" },
  ]);
  const text = out.toString("utf8");
  assert.match(text, /\t"x":\t5,\n  "y"/);
});

test("set on a fresh path creates the parent objects", () => {
  const src = `{
  "a": {
    "b": 1
  }
}
`;
  const out = applyJsoncEdits(src, [
    { pointer: "/a/c", value: "new", op: "set" },
  ]);
  const parsed = JSON.parse(out.toString("utf8"));
  assert.equal(parsed.a.b, 1);
  assert.equal(parsed.a.c, "new");
});

test("delete removes the leaf and preserves the rest", () => {
  const src = `{
  "a": 1,
  "b": 2,
  "c": 3
}
`;
  const out = applyJsoncEdits(src, [
    { pointer: "/b", op: "delete" },
  ]);
  const text = out.toString("utf8");
  assert.doesNotMatch(text, /"b":\s*2/);
  assert.match(text, /"a":\s*1/);
  assert.match(text, /"c":\s*3/);
});

test("multiple edits apply in order without corrupting whitespace", () => {
  const src = `{
  "a": 1,
  "b": 2,
  "c": 3
}
`;
  const out = applyJsoncEdits(src, [
    { pointer: "/a", value: 10, op: "set" },
    { pointer: "/b", op: "delete" },
    { pointer: "/c", value: 30, op: "set" },
  ]);
  const parsed = JSON.parse(out.toString("utf8"));
  assert.equal(parsed.a, 10);
  assert.equal(parsed.c, 30);
  assert.equal(parsed.b, undefined);
});

test("diffPointers: only changed leaves produce edits", () => {
  const before = { a: 1, b: 2, c: { d: 3 } };
  const after = { a: 1, b: 20, c: { d: 3, e: 4 } };
  const edits = diffPointers(before, after, ["/a", "/b", "/c/d", "/c/e", "/missing"]);
  // /a unchanged -> no edit; /b changed -> set; /c/d unchanged -> no
  // edit; /c/e added -> set; /missing added -> set.
  const changed = edits.map((e) => e.pointer).sort();
  assert.deepEqual(changed, ["/b", "/c/e", "/missing"]);
});
