import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { discoverSkillsWithStdout, parseFindOutput } from "../../src/tools/skill-discovery.js";

test("parses owner/repo@skill with K installs", () => {
  const text = readFileSync(new URL("./fixtures/skills-find-react.txt", import.meta.url), "utf8");
  const found = parseFindOutput(text);
  assert.equal(found[0].package, "vercel-labs/agent-skills");
  assert.equal(found[0].skill, "vercel-react-best-practices");
  assert.equal(found[0].installs, 684100);
});

test("parses integer installs", () => {
  const text = readFileSync(new URL("./fixtures/skills-find-react.txt", import.meta.url), "utf8");
  const found = parseFindOutput(text);
  const integerCandidate = found.find((c) => c.skill === "react-best-practices");
  assert.equal(integerCandidate.installs, 2100);
});

test("parses 1.2M install counts", () => {
  const text = readFileSync(new URL("./fixtures/skills-find-react.txt", import.meta.url), "utf8");
  const found = parseFindOutput(text);
  const million = found.find((c) => c.skill === "vercel-react-view-transitions");
  assert.equal(million.installs, 1_200_000);
});

test("strips ANSI before parsing", () => {
  const wrapped = "\x1B[1mvercel-labs/agent-skills@react-best-practices\x1B[0m 684.1K installs\n";
  const found = parseFindOutput(wrapped);
  assert.equal(found.length, 1);
  assert.equal(found[0].package, "vercel-labs/agent-skills");
  assert.equal(found[0].installs, 684100);
});

test("non-empty unparseable output is a contract mismatch", () => {
  const result = discoverSkillsWithStdout("garbage that is not a candidate\n");
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, "registry-contract-mismatch");
});

test("empty parser output returns empty candidates (not a contract mismatch)", () => {
  const found = parseFindOutput("");
  assert.deepEqual(found, []);
});

test("real fixture: candidate owner parsing matches trusted owners list", () => {
  const text = readFileSync(new URL("./fixtures/skills-find-react.txt", import.meta.url), "utf8");
  const found = parseFindOutput(text);
  const owners = new Set(found.map((c) => c.package.split("/")[0]));
  assert.ok(owners.has("vercel-labs"));
  assert.ok(owners.has("anthropics"));
  assert.ok(owners.has("random-user"));
});
