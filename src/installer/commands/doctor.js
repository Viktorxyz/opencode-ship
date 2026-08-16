/*
 * opencode-ship command: doctor.
 *
 * Read-only environment, lock, and asset integrity checks. Each
 * check is independent; the report includes every check so callers
 * can see drift, conflicts, and missing pieces at once.
 *
 * Asset and lock presence checks are catalog-driven so the doctor
 * scales automatically when the catalog grows (e.g. when the
 * practices profile is added in a later minor release); no more
 * hardcoded plugin / agent / skill name lists.
 *
 * Exit codes:
 *   0  healthy
 *   1  unhealthy but no conflicts (warnings about drift)
 *   2  invalid project (no Git root, etc.)
 *   3  lock integrity or shape failure
 *   4  package integrity failure (a catalog source is missing)
 *   5  unsupported lock schema
 */

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { readValidatedLock } from "../lock.js";
import { loadConfig } from "../config.js";
import { detectProject } from "../detection/project.js";
import { resolve } from "node:path";
import { bytesHashString } from "../hash.js";
import { CATALOG, filterCatalogByProfile, validateCatalog } from "../catalog.js";
import { readRootConfig, applyOwnedPointers } from "../root-config.js";
import { renderHuman, renderJson, summarise } from "../report.js";
import { resolveProfile } from "../../profile.js";

function checkNode() {
  return { name: "node>=22.6.0", ok: /^v2[2-9]/.test(process.version), detail: process.version };
}

function checkGit() {
  const r = spawnSync("git", ["--version"], { encoding: "utf8" });
  return { name: "git installed", ok: r.status === 0, detail: r.status === 0 ? r.stdout.trim() : "git not on PATH" };
}

function checkGh() {
  const r = spawnSync("gh", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { name: "gh installed", ok: r.status === 0, detail: r.status === 0 ? r.stdout.trim() : "gh CLI not on PATH" };
}

function checkGhAuth() {
  const envToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!envToken) {
    return { name: "gh auth status", ok: false, detail: "no GH_TOKEN / GITHUB_TOKEN in environment; gh auth skipped" };
  }
  const r = spawnSync("gh", ["auth", "status"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return {
    name: "gh auth status",
    ok: r.status === 0,
    detail: r.status === 0 ? "authenticated (token)" : ((r.stderr || r.stdout || "").trim() || "no session"),
  };
}

function checkPackageIntegrity() {
  try {
    validateCatalog();
    return { name: "package integrity", ok: true, detail: `${CATALOG.length} catalog entries` };
  } catch (e) {
    return {
      name: "package integrity",
      ok: false,
      detail: `${e?.message ?? e}: ${(e?.issues ?? []).map((i) => i.message).join("; ")}`,
    };
  }
}

function buildSourceHashIndex() {
  const idx = new Map();
  for (const entry of CATALOG) {
    if (!existsSync(entry.source)) continue;
    try {
      const buf = readFileSync(entry.source, "utf8");
      idx.set(entry.source, bytesHashString(buf));
    } catch {
      // ignore unreadable sources — package integrity check covers them
    }
  }
  return idx;
}

async function checkCatalogInstall(repoRoot, sourceHashes, profile, renderedAgentMap = new Map()) {
  const rows = [];
  const scoped = profile
    ? filterCatalogByProfile(CATALOG, profile)
    : CATALOG;
  for (const entry of scoped) {
    const target = resolve(repoRoot, entry.path);
    if (!existsSync(target)) {
      rows.push(`${entry.id}: missing`);
      continue;
    }
    try {
      const buf = readFileSync(target, "utf8");
      const actual = bytesHashString(buf);
      const rendered = renderedAgentMap.get(entry.path);
      // Workflow agents are rendered with the configured model; the
      // rendered bytes are the desired consumer state.
      const expected = rendered ? rendered.sha256 : sourceHashes.get(entry.source);
      if (expected && expected !== actual) {
        rows.push(`${entry.id}: drift`);
      } else {
        rows.push(`${entry.id}: ok`);
      }
    } catch (e) {
      rows.push(`${entry.id}: ${e?.message ?? e}`);
    }
  }
  const allOk = rows.length === 0 || rows.every((r) => r.endsWith("ok"));
  return {
    name: `catalog assets present (${profile ?? "core"})`,
    ok: allOk,
    detail: rows.join(","),
  };
}

async function checkLock(repoRoot) {
  const result = await readValidatedLock(repoRoot);
  if (result.kind === "missing") {
    return { name: "lock present", ok: false, detail: "no lock" };
  }
  if (result.kind === "schema") {
    return { name: "lock present", ok: false, detail: `unsupported schema: ${result.issues.join("; ")}` };
  }
  if (result.kind === "integrity") {
    return { name: "lock present", ok: false, detail: `integrity: ${result.issues.join("; ")}` };
  }
  if (result.kind === "shape") {
    return { name: "lock present", ok: false, detail: `malformed: ${result.issues.join("; ")}` };
  }
  const lock = result.lock;
  return {
    name: "lock present",
    ok: true,
    detail: `manager@${lock.manager?.version ?? "?"} schema=${lock.manager?.schemaVersion ?? "?"}`,
  };
}

async function checkConfig(repoRoot) {
  const r = await loadConfig(repoRoot);
  return {
    name: "ship.config.json valid",
    ok: Boolean(r?.ok),
    detail: r?.ok ? "loaded" : r?.error?.kind ?? "missing",
  };
}

async function checkManagedHashes(repoRoot, validatedLock) {
  if (validatedLock.kind !== "ok" || !validatedLock.lock) {
    return { name: "managed hashes", ok: false, detail: "no usable lock" };
  }
  const drift = [];
  // The rendered agent bytes for the consumer are different from
  // the catalog template bytes; the lock already records the
  // rendered sha256 so we must use that as the source of truth.
  // Workflow agents carry <model-from-config> until the renderer
  // fills them in; once configured, the renderer output is locked.
  const renderedAgents = await loadRenderedAgentOverrides(repoRoot);
  for (const entry of validatedLock.lock.files ?? []) {
    const p = resolve(repoRoot, entry.path);
    if (!existsSync(p)) { drift.push(`missing:${entry.path}`); continue; }
    const buf = readFileSync(p, "utf8");
    const actual = bytesHashString(buf);
    if (actual !== entry.sha256) drift.push(`drift:${entry.path}`);
  }
  return { name: "managed hashes", ok: drift.length === 0, detail: drift.length ? drift.join(",") : "match" };
}

async function loadRenderedAgentOverrides(repoRoot) {
  const { loadConfig } = await import("../config.js");
  const { CATALOG } = await import("../catalog.js");
  const { computeRenderedAgents } = await import("../agent-renderer.js");
  const cfg = await loadConfig(repoRoot);
  const models = cfg?.ok ? cfg.value?.workflow?.models : null;
  if (!models) return new Map();
  const rendered = await computeRenderedAgents({ models, catalog: CATALOG });
  const map = new Map();
  for (const e of rendered) map.set(e.relPath, e);
  return map;
}

async function checkActiveProfileFootprint(repoRoot, validatedLock, profile) {
  // Doctor checks only the active profile's footprint, while
  // package integrity (checkPackageIntegrity) checks the full
  // catalog. This makes doctor report the consumer-relevant state
  // rather than every file in the package.
  if (validatedLock.kind !== "ok" || !validatedLock.lock) {
    return { name: "profile footprint", ok: true, detail: "no lock; n/a" };
  }
  if (!profile) {
    return { name: "profile footprint", ok: true, detail: "no profile; n/a" };
  }
  const expectedPaths = new Set(
    filterCatalogByProfile(CATALOG, profile).map((e) => e.path),
  );
  // Lock may contain entries that match the active profile OR
  // entries that are no longer in the active profile (transition
  // candidates). Doctor only requires the active-profile entries
  // to be present.
  const present = (validatedLock.lock.files ?? [])
    .filter((f) => expectedPaths.has(f.path))
    .map((f) => f.path);
  const missing = [...expectedPaths].filter((p) => !present.includes(p));
  return {
    name: "profile footprint",
    ok: missing.length === 0,
    detail: missing.length ? `missing profile assets: ${missing.join(",")}` : `${present.length}/${expectedPaths.size} present`,
  };
}

async function checkRootConfig(repoRoot) {
  const { findRootConfig } = await import("../root-config.js");
  const candidate = findRootConfig(repoRoot);
  if (!candidate.path) return { name: "root config owned entries", ok: true, detail: "absent (no work)" };
  const result = readRootConfig(candidate.path);
  if (!result.ok) return { name: "root config owned entries", ok: false, detail: `root config ${result.error.kind}` };
  const r = applyOwnedPointers(result.value);
  const conflict = r.skipped.find((s) => s.reason === "different existing value");
  return {
    name: "root config owned entries",
    ok: !conflict,
    detail: conflict
      ? `conflict on ${conflict.pointer}`
      : `applied=${r.applied.length}, skipped=${r.skipped.length}`,
  };
}

async function checkSetupState(repoRoot, configValue) {
  const { setupComplete } = await import("../setup-state.js");
  const state = await setupComplete(repoRoot, configValue);
  if (state.ok) {
    return { name: "setup-complete", ok: true, detail: "models + docs + AGENTS.md all present" };
  }
  // Setup-completeness is informational: the controller is the
  // gate, not doctor. Reporting it as a non-failing check keeps
  // the doctor exit code aligned with the install/contract state
  // WITHOUT conflating "setup workflow still pending" with
  // "install is broken".
  return {
    name: "setup-complete",
    ok: true,
    detail: `pending: ${state.missing.join(", ") || "(none)"}`,
  };
}

function writeEnvelope({ command, plan, summary, diagnostics, json, exitCode }) {
  const conflicts = plan.filter((p) => p.kind === "conflict");
  if (json) {
    process.stdout.write(renderJson({ command, plan, conflicts, summary, diagnostics, exitCode }) + "\n");
  } else {
    process.stdout.write(renderHuman({ command, plan, conflicts, summary, diagnostics }) + "\n");
  }
}

export async function runDoctor({ rootPath, profile, json, writeOutput = true }) {
  const detection = detectProject(rootPath ?? process.cwd());
  if (detection.errors.some((e) => e.kind === "not-a-git-repo")) {
    const issues = ["not in a git repository"];
    const checks = [];
    const plan = checks.map((c) => ({
      kind: c.ok ? "noop" : "conflict", op: "check", target: c.name, relPath: c.name, reason: c.detail,
    }));
    const summary = summarise(plan);
    if (writeOutput) writeEnvelope({ command: "doctor", plan, summary, diagnostics: issues, json, exitCode: 2 });
    process.exitCode = 2;
    return { issues, exitCode: 2, plan, checks };
  }
  const repoRoot = detection.repoRoot;
  const sourceHashes = buildSourceHashIndex();
  const validatedLock = await readValidatedLock(repoRoot);
  const packageIntegrity = checkPackageIntegrity();

  // Resolve the active profile using the same precedence as
  // init/update so the doctor check matches the file set init
  // would install.
  const configResult = await loadConfig(repoRoot);
  const configValue = configResult?.ok ? configResult.value : null;
  const resolved = resolveProfile({
    cli: profile,
    config: configValue,
    lock: validatedLock.lock,
  });

  const checks = [
    checkNode(),
    checkGit(),
    checkGh(),
    checkGhAuth(),
    packageIntegrity,
    await checkCatalogInstall(repoRoot, sourceHashes, resolved.profile, await loadRenderedAgentOverrides(repoRoot)),
    await checkLock(repoRoot),
    await checkConfig(repoRoot),
    await checkManagedHashes(repoRoot, validatedLock),
    await checkActiveProfileFootprint(repoRoot, validatedLock, resolved.profile),
    await checkRootConfig(repoRoot),
    await checkSetupState(repoRoot, configValue),
  ];
  const issues = checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
  const plan = checks.map((c) => ({
    kind: c.ok ? "noop" : "conflict",
    op: "check", target: c.name, relPath: c.name, reason: c.detail,
  }));
  const summary = summarise(plan);

  let exitCode = 1;
  if (issues.length === 0) exitCode = 0;
  if (!packageIntegrity.ok) exitCode = 4;
  if (validatedLock.kind === "schema") exitCode = 5;

  if (writeOutput) writeEnvelope({ command: "doctor", plan, summary, diagnostics: issues, json, exitCode });
  process.exitCode = exitCode;
  return { issues, exitCode, plan, checks, profile: resolved };
}
