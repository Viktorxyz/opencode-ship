/*
 * opencode-ship command: init.
 *
 * One-liner install for the engineering profile. The installer:
 *   1. detects the project (git repo, package manager, verifier);
 *   2. plans the install (managed files, root permissions, config,
 *      lock);
 *   3. commits the transaction;
 *   4. auto-runs doctor;
 *   5. writes a setup-pending marker if the workflow.models are
 *      not yet populated;
 *   6. prints next-step instructions so the user knows exactly what
 *      to type next.
 *
 * Exit codes:
 *   0 success
 *   1 with --strict-doctor on unhealthy doctor
 *   2 invalid input (e.g. unknown CLI profile, missing project)
 *   3 managed-file conflict
 *   4 transaction failure
 */

import { promisify } from "node:util";
import { writeFile, mkdir as mkdirAsync } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { previewInstall, commitInstall, serializePlan } from "../executor.js";
import { runDoctor } from "./doctor.js";
import { validateCatalog } from "../catalog.js";
import { hasCompletedModels } from "../config.js";
import { writeSetupPending } from "../setup-pending.js";

const writeFileAsync = promisify(writeFile);
const mkdirAsyncAsync = promisify(mkdirAsync);

export async function runInit(options) {
  try {
    validateCatalog();
  } catch (e) {
    if (e?.catalogValidation) {
      return emitFailure(4, `catalog validation failed: ${e.message}`, options.json, "init");
    }
    throw e;
  }
  let preview;
  try {
    preview = await previewInstall({
      rootPath: options.rootPath ?? null,
      profile: options.profile ?? null,
      replaceManaged: false,
      forceConfig: Boolean(options.forceConfig),
      forceRootConfig: Boolean(options.forceRootConfig),
      models: options.models ?? null,
    });
  } catch (e) {
    return emitFailure(2, e?.message ?? "invalid input", options.json, "init");
  }
  if (!preview.ok) {
    if (preview.error?.kind === "unsupported-lock-schema") {
      return emitFailure(5, `unsupported lock schema: ${(preview.error.issues ?? []).join("; ")}`, options.json, "init");
    }
    if (preview.error?.kind === "engineering-approval-required") {
      return emitFailure(2, preview.error.message, options.json, "init");
    }
    if (preview.error?.kind === "lock-invalid") {
      return emitFailure(3, `lock invalid: ${(preview.error.issues ?? []).join("; ")}`, options.json, "init");
    }
    return emitFailure(2, preview.error?.kind ?? "invalid-project", options.json, "init");
  }
  const committed = await commitInstall(preview, { json: options.json, command: "init" });
  let exitCode = committed.extra?.exitCode ?? 0;
  if (!committed || exitCode !== 0) {
    if (exitCode === 2) return emitFailure(2, committed?.diagnostics?.[0] ?? "invalid project", options.json, "init");
    if (exitCode === 3) return emitFailure(3, committed?.diagnostics?.[0] ?? "conflict", options.json, "init");
    if (exitCode === 4) return emitFailure(4, committed?.diagnostics?.[0] ?? "transaction failure", options.json, "init");
    return emitFailure(exitCode, committed?.diagnostics?.[0] ?? "unknown", options.json, "init");
  }

  const doctor = await runDoctor({
    rootPath: options.rootPath ?? null,
    profile: options.profile ?? null,
    json: Boolean(options.json),
    writeOutput: false,
  });
  /** @type {any} */ committed.extra = { ...(committed.extra ?? {}), doctor: { issues: doctor.issues, checks: doctor.checks, exitCode: doctor.exitCode } };
  committed.diagnostics = [...(committed.diagnostics ?? []), ...(doctor.issues ?? [])];

  if (doctor.issues && doctor.issues.length > 0) {
    committed.diagnostics = [`doctor: ${doctor.issues.length} check(s) unhealthy`, ...committed.diagnostics];
    if (options.strictDoctor) {
      exitCode = 1;
    }
  }

  // Setup-pending marker. The setup-ship-workflow skill removes
  // this file on success. The ship controller checks for it to
  // route ship-deliver through setup before any plan can be
  // drafted.
  const setupPending = Boolean(preview.setupPending);
  if (setupPending && preview.repoRoot) {
    await writeSetupPending(preview.repoRoot, {
      profile: preview.profile?.profile ?? "engineering",
      reason: "workflow.models is empty; run /setup-ship-workflow to fill in model roles",
      createdAt: new Date().toISOString(),
    });
  }

  if (options.json) {
    const envelope = {
      reportVersion: 1,
      command: "init",
      status: exitCode === 0 ? "ok" : "warning",
      plan: serializePlan(committed.plan ?? []),
      conflicts: committed.conflicts ?? [],
      summary: committed.summary ?? {},
      diagnostics: committed.diagnostics ?? [],
      doctor: doctor.issues ?? [],
      doctorChecks: doctor.checks ?? [],
      setupPending,
      exitCode,
    };
    Object.assign(envelope, committed.extra ?? {}, { doctor: doctor.issues ?? [] });
    process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");
  } else {
    printHumanResult({
      prefix: "opencode-ship",
      exitCode,
      doctorIssues: doctor.issues,
      setupPending,
    });
  }

  process.exitCode = exitCode;
  return { ok: exitCode === 0, exitCode, setupPending };
}

function printHumanResult({ prefix, exitCode, doctorIssues, setupPending }) {
  const lines = [];
  if (exitCode === 0) {
    lines.push(`${prefix}: installed; doctor OK`);
  } else {
    lines.push(`${prefix}: installed with warnings`);
  }
  if (Array.isArray(doctorIssues) && doctorIssues.length > 0) {
    lines.push("");
    lines.push("Doctor reported:");
    for (const issue of doctorIssues) lines.push(`  - ${issue}`);
  }
  if (setupPending) {
    lines.push("");
    lines.push("NEXT:");
    lines.push("  1. Restart OpenCode in this repo (if you haven't already).");
    lines.push("  2. In chat, run: /setup-ship-workflow");
    lines.push("     (or type: continue ship setup)");
    lines.push("  3. The skill will ask for:");
    lines.push("       - issue tracker (GitHub / GitLab / local / other)");
    lines.push("       - triage labels (defaults are fine)");
    lines.push("       - domain docs (single-context default)");
    lines.push("       - AI model roles (planner / builder / finalReviewer)");
    lines.push("  4. After setup, try: Ship issue <number>");
    lines.push("");
    lines.push("The controller will refuse to dispatch until setup is complete.");
  } else {
    lines.push("");
    lines.push("NEXT:");
    lines.push("  1. Restart OpenCode in this repo.");
    lines.push("  2. Run: opencode-ship doctor && to confirm everything is clean.");
    lines.push("  3. Run: Ship issue <number>     (or /setup-ship-workflow to customise first)");
  }
  process.stdout.write(lines.join("\n") + "\n");
}

function emitFailure(code, message, json, command) {
  if (json) {
    process.stdout.write(JSON.stringify({
      reportVersion: 1, command, status: "error",
      plan: [], conflicts: [], summary: { create: 0, update: 0, noop: 0, delete: 0, conflict: 0, converge: 0 },
      diagnostics: [message], exitCode: code,
    }, null, 2) + "\n");
  } else {
    process.stdout.write(`opencode-ship: ${message}\n`);
  }
  process.exitCode = code;
  return { ok: false, exitCode: code };
}
