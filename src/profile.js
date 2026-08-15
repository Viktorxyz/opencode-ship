/*
 * opencode-ship profile model.
 *
 * From 1.1.0 onward, the only shipped profile is `engineering`. The
 * `core` profile was removed in the 1.1.0 hard cut because every
 * consumer that today still relies on a `core` installation is
 * either (a) a consumer of a 0.9.x or 1.0.x line that should run
 * `/setup-ship-workflow` and adopt the full lifecycle, or (b) a
 * test fixture that should now use the `engineering` profile and
 * stop verifying the reduced footprint.
 *
 * A consumer whose `ship.config.json` or `ship.lock.json` declares
 * `core` is upgraded to `engineering` on the next `init` or
 * `update`. The CLI refuses `--profile core` with exit 2 because
 * the user can no longer opt into the removed profile for new
 * installs; only persisted legacy state is migrated on read.
 *
 * The profile is resolved per-invocation using precedence:
 *   1. explicit CLI flag (--profile <name>)        (caller-provided)
 *   2. ship.config.json `.profile` field           (user-owned)
 *   3. existing lock `.manager.profile` field      (machine record)
 *   4. default (engineering)
 *
 * Unknown profiles always fail with exit 2 except legacy `core`
 * persisted on disk, which is treated as `engineering` and
 * promoted to engineering in the next lock write. New CLI/config
 * input of `core` is rejected.
 */

export const PROFILES = Object.freeze(["engineering"]);
export const DEFAULT_PROFILE = "engineering";
export const LEGACY_PROFILES = Object.freeze(["core"]);

export function isValidProfile(name) {
  return typeof name === "string" && PROFILES.includes(name);
}

export function isLegacyProfile(name) {
  return typeof name === "string" && LEGACY_PROFILES.includes(name);
}

export function normalizeProfile(name) {
  if (name === undefined || name === null) return DEFAULT_PROFILE;
  if (isValidProfile(name)) return name;
  if (isLegacyProfile(name)) return DEFAULT_PROFILE;
  return null;
}

export function isLegacyCoreProfile(name) {
  return name === "core";
}

/**
 * Resolve the active profile using the documented precedence.
 *
 * Read paths accept legacy `core` values and promote them to
 * engineering. New CLI/config input of `core` is rejected with a
 * descriptive error; only persisted state is migrated.
 *
 * @param {object} sources
 * @param {string|null|undefined} [sources.cli]      precedence 1 (new selection)
 * @param {object|null|undefined} [sources.config]    precedence 2 (user-owned)
 * @param {object|null|undefined} [sources.lock]      precedence 3 (machine record)
 * @returns {{ profile: string, source: "cli"|"config"|"lock"|"default", promotedFrom?: string }}
 */
export function resolveProfile({ cli = null, config = null, lock = null } = {}) {
  if (cli !== null && cli !== undefined) {
    if (isLegacyCoreProfile(cli)) {
      throw new Error(
        `unknown CLI profile 'core' (only 'engineering' is supported in this release; the 'core' profile was removed; existing persisted 'core' is promoted to engineering on next init/update)`
      );
    }
    const v = normalizeProfile(cli);
    if (v === null) {
      throw new Error(
        `unknown CLI profile '${cli}' (only 'engineering' is supported in current release)`
      );
    }
    return { profile: v, source: "cli" };
  }
  if (config && typeof config === "object" && config.profile !== undefined && config.profile !== null) {
    if (isLegacyCoreProfile(config.profile)) {
      return { profile: DEFAULT_PROFILE, source: "default", promotedFrom: "core" };
    }
    const v = normalizeProfile(config.profile);
    if (v === null) {
      throw new Error(
        `unknown ship.config.json profile '${config.profile}' (only 'engineering' is supported in current release)`
      );
    }
    return { profile: v, source: "config" };
  }
  if (lock && typeof lock === "object" && lock.manager && lock.manager.profile !== undefined && lock.manager.profile !== null) {
    if (isLegacyCoreProfile(lock.manager.profile)) {
      return { profile: DEFAULT_PROFILE, source: "default", promotedFrom: "core" };
    }
    const v = normalizeProfile(lock.manager.profile);
    if (v === null) {
      throw new Error(
        `unknown lock manager.profile '${lock.manager.profile}' (only 'engineering' is supported in current release)`
      );
    }
    return { profile: v, source: "lock" };
  }
  return { profile: DEFAULT_PROFILE, source: "default" };
}
