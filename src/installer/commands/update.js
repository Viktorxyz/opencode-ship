/*
 * opencode-ship command: update.
 *
 * Behaves like `init` but fails (exit 3) on conflict unless
 * `--replace-managed` is supplied. Writes the new lock if the
 * transaction commits.
 */

import { previewInstall, commitInstall, serializePlan } from "../executor.js";
import { validateCatalog } from "../catalog.js";
import { clearSetupPending } from "../setup-pending.js";

export async function runUpdate(options) {
  try {
    validateCatalog();
  } catch (e) {
    if (e?.catalogValidation) {
      return emitFailure(4, `catalog validation failed: ${e.message}`, options.json, "update");
    }
    throw e;
  }
  const hasExplicitModels = options.models
    && (options.models.planner || options.models.builder || options.models.finalReviewer);
  const preview = await previewInstall({
    rootPath: options.rootPath,
    profile: options.profile ?? null,
    replaceManaged: options.replaceManaged,
    // If the user passes model flags, the run is explicitly
    // populating workflow.models. We must rewrite the config in
    // that case even when the existing config is otherwise valid.
    forceConfig: Boolean(options.forceConfig || hasExplicitModels),
    forceRootConfig: options.forceRootConfig,
    models: options.models ?? null,
  });
  if (!preview.ok) {
    if (preview.error?.kind === "unsupported-lock-schema") {
      return emitFailure(5, `unsupported lock schema: ${(preview.error.issues ?? []).join("; ")}`, options.json, "update");
    }
    if (preview.error?.kind === "lock-invalid") {
      return emitFailure(3, `lock invalid: ${(preview.error.issues ?? []).join("; ")}`, options.json, "update");
    }
    return emitFailure(2, preview.error?.kind ?? "invalid-project", options.json, "update");
  }
  if (preview.conflicts.length > 0 && !options.replaceManaged) {
    return emitFailure(3, "modified managed files; rerun with --replace-managed", options.json, "update");
  }
  const committed = await commitInstall(preview, { json: options.json, command: "update" });
  // After a successful update, clear the setup-pending marker so
  // `ship-deliver` does not need to route through setup again.
  if (committed.extra?.exitCode === 0 && preview.repoRoot && !preview.setupPending) {
    clearSetupPending(preview.repoRoot);
  }
  if (options.json) {
    process.stdout.write(JSON.stringify({
      reportVersion: 1,
      command: "update",
      status: committed.extra?.exitCode === 0 ? "ok" : "error",
      plan: serializePlan(committed.plan ?? []),
      conflicts: committed.conflicts ?? [],
      summary: committed.summary ?? {},
      diagnostics: committed.diagnostics ?? [],
      exitCode: committed.extra?.exitCode ?? 0,
      setupPending: Boolean(preview.setupPending),
      ...(committed.extra ?? {}),
    }, null, 2) + "\n");
  } else if (committed.extra?.exitCode === 0) {
    process.stdout.write(`opencode-ship: update OK\n`);
  }
  process.exitCode = committed.extra?.exitCode ?? 0;
  return committed;
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
