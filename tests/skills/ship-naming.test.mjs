import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const FILES = [
  "assets/skills/writing-plans/SKILL.md",
  "assets/skills/ship-workflow/SKILL.md",
  "assets/commands/ship-deliver.md",
  "assets/skills/executing-plans/SKILL.md",
];

test("ship naming: writing-plans, ship-workflow, ship-deliver, executing-plans have no delivery_ substring", () => {
  for (const rel of FILES) {
    const src = readFileSync(resolve(rel), "utf8");
    assert.equal(
      src.includes("delivery_"),
      false,
      `${rel} must not contain delivery_ (use ship_* only)`,
    );
  }
});
