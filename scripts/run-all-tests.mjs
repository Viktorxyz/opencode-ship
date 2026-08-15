#!/usr/bin/env node
/* Discover and run every `*.test.mjs` test under `tests/`. */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function discover(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const st = statSync(path);
    if (st.isDirectory()) {
      discover(path, out);
    } else if (entry.endsWith(".test.mjs")) {
      out.push(path);
    }
  }
  return out.sort();
}

const tests = discover("tests");
if (tests.length === 0) {
  console.error("no tests found under tests/");
  process.exit(1);
}
// `node --test` walks the file list directly. The tests are all
// `.mjs`; no TS compilation is needed. The runner is invoked
// without `tsx` so the CI environment is no longer dependent on
// a working TypeScript runtime.
const r = spawnSync("node", [
  "--test",
  "--test-concurrency=1",
  "--test-reporter=spec",
  ...tests,
], {
  stdio: "inherit",
  env: { ...process.env, NODE_NO_WARNINGS: "1" },
});
process.exit(r.status ?? 1);
