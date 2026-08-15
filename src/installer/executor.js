/*
 * Reconciliation executor shared by `init`, `update`, and `diff`.
 *
 * Produces a single ordered plan across three classes:
 *   - user-owned config synthesis (`ship.config.json`);
 *   - root opencode.json / .jsonc JSON pointer edits (Build
 *     permissions only);
 *   - managed plugin / agents / skills / ship.lock.json file ops.
 *
 * Outputs the structured `Plan` object, the assembled lock object,
 * and a list of human-readable conflicts. The commit semantics are
 * controlled by the calling command (`diff` does not commit).
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { CATALOG, filterCatalogByProfile, TEMPLATE_SET_ID } from "./catalog.js";
import { PACKAGE_VERSION } from "../version.js";
import {
  planFileInstall,
  planStaleFileRemoval,
  planMigrationCleanup,
  planConfigSynthesis,
  planRootConfigApply,
  planUninstall,
} from "./planner.js";
import { readValidatedLock, writeLock, CURRENT_LOCK_SCHEMA } from "./lock.js";
import { loadConfig, writeConfig, renderDefaultConfig, hasCompletedModels } from "./config.js";
import { bytesHashString } from "./hash.js";
import { stableStringify } from "./json-pointer.js";
import { detectProject } from "./detection/project.js";
import { readRootConfig } from "./root-config.js";
import { lockPath } from "./lock.js";
import { executePlan } from "./transaction.js";
import { migration } from "./migration.js";
import { resolveProfile } from "../profile.js";

async function readCurrentBytes(targetPath) {
  if (!existsSync(targetPath)) return null;
  const buf = await readFile(targetPath);
  return { bytes: buf, hash: bytesHashString(buf.toString("utf8")) };
}

async function gatherAllTargets(repoRoot) {
  const out = [];
  for (const entry of CATALOG) {
    out.push({ target: resolve(repoRoot, entry.path) });
  }
  out.push({ target: resolve(repoRoot, ".opencode/ship.lock.json") });
  out.push({ target: resolve(repoRoot, ".opencode/ship.config.json") });
  return out;
}

export async function previewInstall({ rootPath, profile = null, replaceManaged, forceConfig, forceRootConfig, models = null }) {
  const detection = detectProject(rootPath ?? process.cwd());
  if (detection.errors.some((e) => e.kind === "not-a-git-repo")) {
    return { ok: false, error: { kind: "invalid-project", errors: detection.errors } };
  }
  const repoRoot = detection.repoRoot;
  const validatedLock = await readValidatedLock(repoRoot);
  if (validatedLock.kind === "schema") {
    return { ok: false, error: { kind: "unsupported-lock-schema", issues: validatedLock.issues } };
  }
  if (validatedLock.kind === "integrity" || validatedLock.kind === "shape") {
    return { ok: false, error: { kind: "lock-invalid", issues: validatedLock.issues } };
  }
  const lock = validatedLock.lock;
  const migrationReport = await migration({ repoRoot, lock, forceRepair: false, detection });

  // Resolve the active profile using the documented precedence
  // (CLI > ship.config > lock > core). resolveProfile throws on
  // any unknown source; the CLI surface maps that to exit 2.
  const configResult = await loadConfig(repoRoot);
  const configValue = configResult?.ok ? configResult.value : null;
  const resolved = resolveProfile({
    cli: profile,
    config: configValue,
    lock,
  });

  // The engineering profile is the only supported profile in 1.1.0.
  // The one-liner flow (no model flags) succeeds with the
  // setup-pending marker; the user finishes setup via
  // /setup-ship-workflow. --force-config however requires explicit
  // models for every role because it bypasses the default
  // synthesis — refusing prevents a half-configured engineering
  // install.
  if (resolved.profile === "engineering" && forceConfig) {
    const existingModels = configValue?.workflow?.models ?? {};
    const planner = models?.planner ?? existingModels.planner;
    const builder = models?.builder ?? existingModels.builder;
    const finalReviewer = models?.finalReviewer ?? existingModels.finalReviewer;
    if (!planner || !builder || !finalReviewer) {
      return {
        ok: false,
        error: {
          kind: "engineering-models-required",
          message: "engineering profile with --force-config requires --planner-model, --builder-model, and --final-reviewer-model",
        },
      };
    }
  }
  if (resolved.profile === "engineering") {
    const candidate = await planConfigSynthesis({
      repoRoot, detection, lock, forceOverwrite: Boolean(forceConfig),
      migrationSeed: migrationReport?.proposedConfigSeed ?? null,
      models,
    });
    if (candidate.kind === "create" || candidate.kind === "update") {
      const configValue = candidate.configValue;
      if (!configValue.workflow || !configValue.workflow.approval) {
        return { ok: false, error: { kind: "engineering-approval-required", message: "engineering profile requires workflow.approval.{mirrorToIssue:true, maxFailedRounds:3}" } };
      }
    }
  }

  const previousProfile = lock?.manager?.profile ?? null;
  const isProfileTransition = previousProfile && previousProfile !== resolved.profile;

  // The active catalog is the set of files the new profile ships.
  // A profile transition must also remove files that the new
  // profile no longer ships but the previous profile did; this is
  // the engineering -> core cleanup.
  const activeCatalog = filterCatalogByProfile(CATALOG, resolved.profile);
  const staleCatalog = isProfileTransition
    ? filterCatalogByProfile(CATALOG, previousProfile).filter((e) => !activeCatalog.includes(e))
    : [];

  const configPlan = await planConfigSynthesis({
    repoRoot, detection, lock, forceOverwrite: Boolean(forceConfig),
    migrationSeed: migrationReport?.proposedConfigSeed ?? null,
    models,
  });

  // When the engineering profile has configured model roles, the
  // installer renders the workflow agent frontmatter so the
  // consumer's agents carry the configured `model:` value. The
  // lock pins the rendered sha256 so subsequent updates detect
  // the model change as a managed asset update.
  const { buildRenderedOverride } = await import("./agent-renderer.js");
  const configModels = configPlan?.configValue?.workflow?.models ?? {};
  const rendered = await buildRenderedOverride({
    models: resolved.profile === "engineering" ? configModels : null,
    catalog: CATALOG,
  });

  const filePlan = await planFileInstall({
    repoRoot,
    lock,
    allowUnowned: Boolean(replaceManaged),
    catalog: activeCatalog,
    renderedOverride: rendered.map,
  });
  const staleFilePlan = await planStaleFileRemoval({ repoRoot, lock, staleCatalog });
  const migrationPlan = await planMigrationCleanup({
    repoRoot,
    lock,
    migrationReport,
    allowUnowned: Boolean(replaceManaged),
  });
  // The Plan Mode permission block is consumer-owned from the current release
  // on. The installer only owns Build-agent delivery pointers and
  // does NOT inject /agent/plan/permission. The active-profile
  // gate stays the same precedence chain for the file install.
  const planMode = null;
  const rootPlan = await planRootConfigApply({ repoRoot, lock, forceRepair: Boolean(forceRootConfig), planMode });

  // When the engineering profile is being applied without models
  // we mark the consumer as "setup pending" so the controller
  // routes ship-deliver through /setup-ship-workflow until the
  // workflow.models fields are populated. The marker is removed by
  // the setup-ship-workflow skill on success.
  const setupPending = resolved.profile === "engineering"
    && !lock?.manager?.setupComplete
    && !hasCompletedModels(configValue)
    && !models?.planner;

  const plan = [...(filePlan ?? []), ...staleFilePlan, ...migrationPlan, configPlan, rootPlan];
  const conflicts = plan.filter((p) => p && p.kind === "conflict");
  const summary = summarise(plan);
  return {
    ok: true,
    repoRoot,
    detection,
    lock,
    profile: resolved,
    previousProfile,
    isProfileTransition,
    plan,
    conflicts,
    summary,
    migrationReport,
    setupPending,
  };
}

export async function previewUninstall({ rootPath }) {
  const detection = detectProject(rootPath ?? process.cwd());
  if (detection.errors.some((e) => e.kind === "not-a-git-repo")) {
    return { ok: false, error: { kind: "invalid-project" } };
  }
  const repoRoot = detection.repoRoot;
  const validatedLock = await readValidatedLock(repoRoot);
  if (validatedLock.kind === "schema") {
    return { ok: false, error: { kind: "unsupported-lock-schema", issues: validatedLock.issues } };
  }
  if (validatedLock.kind === "integrity" || validatedLock.kind === "shape") {
    return { ok: false, error: { kind: "lock-invalid", issues: validatedLock.issues } };
  }
  const lock = validatedLock.lock;
  if (!lock) {
    return { ok: true, repoRoot, lock: null, plan: [], conflicts: [], summary: summarise([]) };
  }
  const plan = await planUninstall({ repoRoot, lock });
  const conflicts = plan.filter((p) => p.kind === "conflict");
  return { ok: true, repoRoot, lock, plan, conflicts, summary: summarise(plan) };
}

function summarise(plan) {
  const counts = { create: 0, update: 0, noop: 0, delete: 0, conflict: 0, converge: 0, lock: 0, config: 0, rootConfig: 0 };
  for (const op of plan) {
    if (!op) continue;
    if (op.op === "lock") counts.lock += 1;
    else if (op.op === "config") counts.config += 1;
    else if (op.op === "root-config") counts.rootConfig += 1;
    else if (counts[op.kind] !== undefined) counts[op.kind] += 1;
  }
  return counts;
}

async function assembleLock({ repoRoot, plan, lock, configPlan, rootPlan, profile = null, models = null }) {
  const files = [];
  const remain = lock?.files?.filter((f) => !plan.some((op) => op?.relPath === f.path)) ?? [];

  for (const op of plan) {
    if (!op || op.op !== "file") continue;
    if (op.kind === "delete" || op.kind === "conflict") continue;
    const entry = CATALOG.find((c) => c.path === op.relPath);
    if (!entry) continue;
    let hash = op.sha256;
    if (!hash && op.target) {
      const cur = await readCurrentBytes(op.target);
      if (cur) hash = cur.hash;
    }
    files.push({
      path: op.relPath,
      sha256: hash ?? null,
      mode: 0o644,
      template: relativeTemplate(entry.source),
      kind: entry.kind,
    });
  }
  for (const f of remain) {
    files.push({ ...f });
  }

  const configSha = configPlan?.kind === "create" || configPlan?.kind === "update"
    ? configPlan.desiredSha
    : configPlan?.kind === "noop" ? configPlan.currentSha : null;
  const rootPointers = rootPlan?.pointerRecords ?? lock?.manager?.rootDocuments?.[0]?.pointers ?? [];
  const hasRootPlan = Boolean(rootPlan?.target || (rootPlan?.pointerRecords && rootPlan.pointerRecords.length > 0));
  const hasRootDocuments = (rootPlan?.pointerRecords && rootPlan.pointerRecords.length > 0)
    || (lock?.manager?.rootDocuments && lock.manager.rootDocuments.length > 0);

  // Models are considered "complete" once all three roles are
  // populated in the assembled config. The setupComplete flag
  // tells the controller that dispatch can begin; the absence of
  // this flag (or setupPending=true in the preview) forces the
  // ship-deliver controller to route through /setup-ship-workflow.
  const assembledConfig = configPlan?.configValue
    ?? (lock?.manager?.config?.models
      ? { workflow: { models: lock.manager.config.models } }
      : null);
  const completedModels = hasCompletedModels(assembledConfig);
  const resolvedProfile = profile
    ?? (lock?.manager?.profile === "core" ? "engineering" : lock?.manager?.profile)
    ?? "engineering";

  return {
    contractVersion: CURRENT_LOCK_SCHEMA,
    manager: {
      schemaVersion: CURRENT_LOCK_SCHEMA,
      name: "opencode-ship",
      version: process.env.OPENCODE_SHIP_VERSION ?? PACKAGE_VERSION,
      templateSet: TEMPLATE_SET_ID,
      profile: resolvedProfile,
      appliedAt: new Date().toISOString(),
      setupComplete: completedModels,
      config: {
        path: ".opencode/ship.config.json",
        sha256: configSha ?? lock?.manager?.config?.sha256 ?? "",
        existed: Boolean(lock?.manager?.config?.existed),
      },
      rootDocuments: hasRootDocuments && (hasRootPlan || (lock?.manager?.rootDocuments?.length ?? 0) > 0) ? [{
        path: rootPlan?.relPath ?? lock?.manager?.rootDocuments?.[0]?.path ?? "opencode.json",
        format: rootPlan?.format ?? lock?.manager?.rootDocuments?.[0]?.format ?? "json",
        pointers: rootPlan?.pointerRecords && rootPlan.pointerRecords.length > 0
          ? rootPlan.pointerRecords
          : (lock?.manager?.rootDocuments?.[0]?.pointers ?? []),
      }] : [],
    },
    files,
  };
}

export async function commitInstall(preview, { json, command }) {
  if (!preview.ok) {
    return {
      ok: false, command, plan: [], conflicts: [], summary: summarise([]),
      diagnostics: [preview.error?.kind ?? "invalid-project"],
      /** @type {any} */ extra: { exitCode: 2, repoRoot: null, migrationReport: null },
    };
  }
  const { repoRoot, plan, conflicts, migrationReport } = preview;
  const filePlans = plan.filter((op) => op.op === "file");
  const configPlan = plan.find((op) => op.op === "config");
  const rootPlan = plan.find((op) => op.op === "root-config");
  const fileOnly = filePlans;
  if (conflicts.length > 0) {
    return {
      ok: false, command, plan, conflicts,
      summary: summarise(plan),
      diagnostics: ["hash conflict; refuse to overwrite"],
      /** @type {any} */ extra: { exitCode: 3, repoRoot, migrationReport },
    };
  }

  const newLockObject = await assembleLock({
    repoRoot,
    plan: fileOnly,
    lock: preview.lock,
    configPlan,
    rootPlan,
    profile: preview.profile?.profile,
  });

  const txPlan = await stageFiles(fileOnly, repoRoot);
  if (configPlan && (configPlan.kind === "create" || configPlan.kind === "update")) {
    txPlan.push({
      op: "file",
      kind: configPlan.kind === "create" ? "create" : "update",
      target: configPlan.target,
      bytes: configPlan.bytes,
      mode: 0o644,
      relPath: configPlan.relPath,
    });
  }
  if (rootPlan && (rootPlan.kind === "create" || rootPlan.kind === "update")) {
    txPlan.push({
      op: "file",
      kind: rootPlan.kind,
      target: rootPlan.target,
      bytes: rootPlan.bytes,
      mode: 0o644,
      relPath: rootPlan.relPath,
    });
  }

  const tx = await executePlan({
    repoRoot,
    plan: txPlan,
    newLockBuilder: async () => newLockObject,
  });
  if (!tx.ok) {
    return {
      ok: false, command, plan, conflicts: [],
      summary: summarise(plan),
      diagnostics: [tx.error?.message ?? "transaction failure"],
      extra: { exitCode: 4, repoRoot, migrationReport, recovered: false },
    };
  }
  return {
    ok: true, command, plan, conflicts: [],
    summary: summarise(plan),
    diagnostics: [],
    extra: { exitCode: 0, repoRoot, migrationReport, recovered: tx.recovered },
  };
}

async function stageFiles(filePlan, repoRoot) {
  /** @type {Array<{op:string;kind:string;target:string;bytes?:Buffer;mode?:number;relPath?:string}>} */
  const out = [];
  for (const op of filePlan) {
    if (op.kind === "conflict" || op.kind === "noop" || op.kind === "converge") continue;
    if (op.kind === "delete") {
      out.push({
        op: "file",
        kind: "delete",
        target: op.target,
        relPath: op.relPath,
      });
      continue;
    }
    out.push({
      op: "file",
      kind: op.kind,
      target: op.target,
      bytes: op.bytes ?? Buffer.alloc(0),
      mode: op.mode ?? 0o644,
    });
  }
  return out;
}

export function serializePlan(plan) {
  return plan.filter(Boolean).map((op) => {
    if (!op) return null;
    const { bytes, ...rest } = op;
    if (bytes && Buffer.isBuffer(bytes)) {
      return { ...rest, bytesLength: bytes.length };
    }
    return rest;
  });
}

function relativeTemplate(source) {
  if (typeof source !== "string") return source;
  const prefix = `${process.cwd()}/`;
  if (source.startsWith(prefix)) return source.slice(prefix.length);
  return source;
}

function emit(command, plan, conflicts, { summary, json, exitCode, diagnostics, extra }) {
  if (json) {
    const safePlan = serializePlan(plan);
    const safeConflicts = serializePlan(conflicts);
    process.stdout.write(JSON.stringify({
      reportVersion: 1,
      command,
      status: conflicts.length > 0 ? "conflict" : exitCode === 0 ? "ok" : "error",
      plan: safePlan,
      conflicts: safeConflicts,
      summary,
      diagnostics,
      exitCode,
      ...(extra ?? {}),
    }, null, 2) + "\n");
  } else {
    const head = `# opencode-ship ${command}`;
    const lines = [head, "", "## Plan"];
    for (const op of plan.filter(Boolean)) {
      const bytesHint = op.bytes ? `${(op.bytes.length ?? 0)}b` : "";
      lines.push(`  - ${op.kind.padEnd(9)} ${op.op} ${op.relPath ?? op.target}${bytesHint ? ` (${bytesHint})` : ""}${op.reason ? ` — ${op.reason}` : ""}`);
    }
    if (conflicts.length) {
      lines.push("", `## Conflicts (${conflicts.length})`);
      for (const c of conflicts) lines.push(`  - ${c.relPath ?? c.target}: ${c.reason}`);
    }
    if (diagnostics?.length) {
      lines.push("", "## Diagnostics");
      for (const d of diagnostics) lines.push(`  - ${d}`);
    }
    lines.push("", `Summary: ${JSON.stringify(summary)}`);
    process.stdout.write(lines.join("\n") + "\n");
  }
  process.exitCode = exitCode;
  return { ok: true, exitCode, extra };
}

function exitWith(code, message, json, command) {
  if (json) {
    process.stdout.write(JSON.stringify({
      reportVersion: 1, command, status: "error",
      plan: [], conflicts: [], summary: summarise([]),
      diagnostics: [message], exitCode: code,
    }, null, 2) + "\n");
  } else {
    process.stdout.write(`opencode-ship: ${message}\n`);
  }
  process.exitCode = code;
  return { ok: false, exitCode: code };
}
