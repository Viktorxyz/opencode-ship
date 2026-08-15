/*
 * Argument parsing for opencode-ship.
 *
 * Minimal, dependency-free parser with strict subcommand dispatch and
 * stable `--root` / `--json` / `--force-config` / `--force-root-config`,
 * `--strict-doctor`, `--replace-managed`, `--purge-config` flags.
 *
 * From 1.1.0 the engineering profile is the default. The CLI still
 * accepts `--profile engineering` but exits 2 on `--profile core`
 * because that profile was removed in 1.1.0. Model flags are
 * optional: init writes a placeholder `workflow.models` and the
 * setup-ship-workflow skill fills them in.
 */

import { PROFILES, isValidProfile } from "../profile.js";

const USAGE = `opencode-ship <command> [options]

Commands:
  init        Install managed files in this project. One-liner: pnpm dlx opencode-ship@latest init
  diff        Show what would change without writing.
  update      Apply pending updates after recovering the journal.
  doctor      Validate environment, lock, and references.
  uninstall   Remove managed files that still match the lock.
  --version   Print the version and exit.
  --help      Show this usage and exit.

Options:
  --root <path>               Project root (defaults to cwd).
  --profile engineering       Override active profile (engineering only).
  --force-config              Rewrite the user config from detection (init only).
  --force-root-config         Create opencode.json when absent (init only).
  --strict-doctor             Fail init when doctor reports unhealthy checks.
  --replace-managed           Replace locally-modified managed files (update only).
  --purge-config              Remove ship.config.json when uninstalling.
  --planner-model <id>        Strong planner model id (init only, optional).
  --builder-model <id>        Cheap builder model id (init only, optional).
  --final-reviewer-model <id> Final Standards + Spec reviewer model id (init only, optional).
  --json                      Emit a JSON envelope instead of human output.

After init succeeds, restart OpenCode and run /setup-ship-workflow to
fill in the workflow.models fields and the per-repo docs.
`;

const MODEL_ID_RE = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

export function parseFlags(argv) {
  const options = {
    rootPath: null,
    profile: null,
    json: false,
    replaceManaged: false,
    purgeConfig: false,
    forceConfig: false,
    forceRootConfig: false,
    strictDoctor: false,
    plannerModel: null,
    builderModel: null,
    finalReviewerModel: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--replace-managed") options.replaceManaged = true;
    else if (arg === "--purge-config") options.purgeConfig = true;
    else if (arg === "--force-config") options.forceConfig = true;
    else if (arg === "--force-root-config") options.forceRootConfig = true;
    else if (arg === "--strict-doctor") options.strictDoctor = true;
    else if (arg === "--root") options.rootPath = argv[++i];
    else if (arg === "--profile") {
      const value = argv[++i];
      if (value === undefined) {
        return { error: "--profile requires a value" };
      }
      if (value === "core") {
        return {
          error:
            "the 'core' profile was removed in opencode-ship 1.1.0; only 'engineering' is supported. Run /setup-ship-workflow to migrate.",
        };
      }
      if (!isValidProfile(value)) {
        return { error: `unknown profile '${value}' (expected one of: ${PROFILES.join(", ")})` };
      }
      options.profile = value;
    } else if (arg === "--planner-model" || arg === "--builder-model" || arg === "--final-reviewer-model") {
      const value = argv[++i];
      if (value === undefined) return { error: `${arg} requires a value` };
      if (!MODEL_ID_RE.test(value)) {
        return { error: `${arg} must be a "<provider>/<model>" id, got ${JSON.stringify(value)}` };
      }
      if (arg === "--planner-model") options.plannerModel = value;
      else if (arg === "--builder-model") options.builderModel = value;
      else options.finalReviewerModel = value;
    } else if (arg === "-h" || arg === "--help") return { help: true };
    else if (arg === "-v" || arg === "--version") return { version: true };
    else return { error: `unknown flag ${arg}` };
  }
  return options;
}

export function parseCommand(argv) {
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") return { command: "help" };
    if (arg === "--version" || arg === "-v") return { command: "version" };
  }
  const [cmd, ...rest] = argv;
  if (!cmd) return { command: "help" };
  const flags = parseFlags(rest);
  if ("help" in flags) return { command: "help" };
  if ("version" in flags) return { command: "version" };
  if ("error" in flags) return { error: flags.error };
  switch (cmd) {
    case "init":
    case "diff":
    case "update":
    case "doctor":
    case "uninstall":
      return { command: cmd, options: flags };
    default:
      return { error: `unknown command ${cmd}` };
  }
}

export function helpText() {
  return USAGE;
}
