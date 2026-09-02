import test from "node:test";
import assert from "node:assert/strict";
import { stackQueries } from "../../src/skills/stack-queries.js";

test("stackQueries: react + vitest from package.json", () => {
  const q = stackQueries({
    packageJson: {
      dependencies: { react: "19.0.0" },
      devDependencies: { vitest: "3.0.0", leftpad: "1.0.0" },
    },
  });
  assert.deepEqual([...q].sort(), ["react", "vitest"]);
});

test("stackQueries: unknown deps yield nothing", () => {
  const q = stackQueries({ packageJson: { dependencies: { leftpad: "1.0.0" } } });
  assert.deepEqual(q, []);
});

test("stackQueries: issue text appends extra query without replacing stack", () => {
  const q = stackQueries({
    packageJson: { dependencies: { react: "19.0.0" } },
    issueText: "add playwright coverage",
  });
  assert.ok(q.includes("react"));
  assert.ok(q.includes("playwright"));
});

test("stackQueries: caps at 5 unique queries", () => {
  const q = stackQueries({
    packageJson: {
      dependencies: {
        react: "1", next: "1", express: "1", fastify: "1",
        prisma: "1", "drizzle-orm": "1",
      },
    },
  });
  assert.equal(q.length, 5);
});
