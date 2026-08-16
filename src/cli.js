/*
 * opencode-ship CLI entry point.
 *
 * Parses argv with the dependency-free parser, dispatches to the
 * command modules, and emits a stable exit code via process.exitCode.
 */

import { parseCommand, helpText } from "./installer/cli-args.js";
import { runInit } from "./installer/commands/init.js";
import { runDiff } from "./installer/commands/diff.js";
import { runUpdate } from "./installer/commands/update.js";
import { runSetupComplete } from "./installer/commands/setup-complete.js";
import { runUninstall } from "./installer/commands/uninstall.js";
import { runDoctor } from "./installer/commands/doctor.js";
import { PACKAGE_VERSION } from "./version.js";

const VERSION = PACKAGE_VERSION;

async function main() {
  const parsed = parseCommand(process.argv.slice(2));
  if (parsed.command === "help") {
    process.stdout.write(helpText() + "\n");
    process.exitCode = 0;
    return;
  }
  if (parsed.command === "version") {
    process.stdout.write(`opencode-ship ${VERSION}\n`);
    process.exitCode = 0;
    return;
  }
  if ("error" in parsed) {
    process.stderr.write(`opencode-ship: ${parsed.error}\n\n${helpText()}`);
    process.exitCode = 2;
    return;
  }
  const options = parsed.options ?? {};
  /** @type {any} */ const opts = options;
  const profile = opts.profile ?? null;
  const models = {
    planner: opts.plannerModel ?? null,
    builder: opts.builderModel ?? null,
    finalReviewer: opts.finalReviewerModel ?? null,
  };
  const hasModels = Boolean(models.planner || models.builder || models.finalReviewer);
  switch (parsed.command) {
    case "init":
      await runInit({
        json: !!opts.json,
        rootPath: opts.rootPath,
        profile,
        forceConfig: !!opts.forceConfig,
        forceRootConfig: !!opts.forceRootConfig,
        strictDoctor: !!opts.strictDoctor,
        models: hasModels ? models : null,
      });
      return;
    case "diff":
      await runDiff({ json: !!opts.json, rootPath: opts.rootPath, profile, models: hasModels ? models : null });
      return;
    case "update":
      await runUpdate({
        json: !!opts.json,
        rootPath: opts.rootPath,
        profile,
        replaceManaged: !!opts.replaceManaged,
        forceConfig: !!opts.forceConfig,
        forceRootConfig: !!opts.forceRootConfig,
        models: hasModels ? models : null,
      });
      return;
    case "doctor":
      await runDoctor({ json: !!opts.json, rootPath: opts.rootPath, profile });
      return;
    case "setup-complete":
      await runSetupComplete({ json: !!opts.json, rootPath: opts.rootPath });
      return;
    case "uninstall":
      await runUninstall({ json: !!opts.json, rootPath: opts.rootPath, profile, purgeConfig: !!opts.purgeConfig });
      return;
    default:
      process.stdout.write(helpText() + "\n");
      process.exitCode = 2;
  }
}

main().catch((e) => {
  process.stderr.write(`opencode-ship: internal failure: ${e?.message ?? String(e)}\n`);
  if (e?.stack) process.stderr.write(e.stack + "\n");
  process.exitCode = 4;
});
