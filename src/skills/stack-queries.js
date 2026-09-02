import { readFileSync } from "node:fs";
import { join } from "node:path";

export const STACK_DEP_QUERIES = {
  react: "react",
  "react-dom": "react",
  next: "nextjs",
  vitest: "vitest",
  playwright: "playwright",
  tailwindcss: "tailwind",
  express: "express",
  fastify: "fastify",
  prisma: "prisma",
  "drizzle-orm": "drizzle",
};

/**
 * @param {{ packageJson?: object | null, issueText?: string }} [input]
 * @returns {string[]}
 */
export function stackQueries({ packageJson, issueText } = {}) {
  const found = [];
  const seen = new Set();
  const add = (q) => {
    if (!q || seen.has(q) || found.length >= 5) return;
    seen.add(q);
    found.push(q);
  };
  const deps = {
    ...(packageJson?.dependencies ?? {}),
    ...(packageJson?.devDependencies ?? {}),
  };
  for (const name of Object.keys(deps)) {
    add(STACK_DEP_QUERIES[name]);
  }
  const text = String(issueText ?? "");
  if (/playwright/i.test(text)) add("playwright");
  if (/\breact\b/i.test(text)) add("react");
  if (/nextjs|next\.js|\bnext\b/i.test(text)) add("nextjs");
  if (/vitest|testing library/i.test(text)) add("vitest");
  if (/tailwind/i.test(text)) add("tailwind");
  return found;
}

export function readPackageJson(repoRoot) {
  try {
    const raw = readFileSync(join(repoRoot, "package.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}
