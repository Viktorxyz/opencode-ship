import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

for (const axis of ["standards", "spec"]) {
  test(`final ${axis} reviewer records its axis through ship_final_review`, async () => {
    const source = await readFile(`assets/agents/ship-final-${axis}-reviewer.md`, "utf8");
    const frontmatter = source.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    assert.match(frontmatter, /ship_final_review:\s*allow/);
    assert.match(frontmatter, /delivery_review:\s*deny/);
    assert.match(source, new RegExp(`ship_final_review[\\s\\S]+axis: ["']${axis}["']`));
  });
}
