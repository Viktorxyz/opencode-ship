/**
 * Real OpenCode dispatch + caller identity.
 *
 * The controller runtime creates a child OpenCode session for
 * every worker role (planner, builder, task-reviewer, Standards
 * final-reviewer, Spec final-reviewer). The child session id
 * is recorded in a durable dispatch record keyed by:
 *
 *   planner:<revision>
 *   builder:<taskId>:<round>
 *   task-reviewer:<taskId>:<round>
 *   final-reviewer:<packageHash>:standards
 *   final-reviewer:<packageHash>:spec
 *
 * Every dispatch goes through the same state machine so
 * retry, recovery, and orphan cleanup behave uniformly:
 *
 *   prepared      intent + key + payload hashes persisted
 *   created       client.session.create returned a session id
 *   prompted      client.session.promptAsync accepted the prompt
 *   completed     the prompt returned without throwing
 *   failed        the prompt raised; lastError captured
 *   orphaned      the session was deleted (manual or OOM)
 *
 * The controller session lease is recorded under the workflow
 * state. The ship-controller child must call every controller
 * tool from the exact session that owns the lease; any other
 * session is rejected by `authorizeControllerCall`.
 *
 * Worker authorization:
 *
 *   ship_plan_submit         -> exact planner child session
 *   ship_task_report         -> exact builder child session
 *   ship_task_review         -> exact task-reviewer child session
 *   ship_final_review        -> exact axis-specific child session
 *
 * `submittedBy` and caller-supplied `sessionID` strings are
 * telemetry only; they are NEVER consulted for authorization.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveGitCommonDir, opencodeShipStateDir } from "../state/git-common-dir.js";
import { publishImmutableJson, withResourceLock } from "../state/durable-store.js";
import { createHash } from "node:crypto";

const ROLE_PLANNER = "planner";
const ROLE_BUILDER = "builder";
const ROLE_TASK_REVIEWER = "task-reviewer";
const ROLE_FINAL_STANDARDS = "final-standards";
const ROLE_FINAL_SPEC = "final-spec";

const ROLE_KEYS = new Set([ROLE_PLANNER, ROLE_BUILDER, ROLE_TASK_REVIEWER, ROLE_FINAL_STANDARDS, ROLE_FINAL_SPEC]);

function dispatchKeyFor(role, input) {
  switch (role) {
    case ROLE_PLANNER:
      return `planner:${input.revision}`;
    case ROLE_BUILDER:
      return `builder:${input.taskId}:${input.round}`;
    case ROLE_TASK_REVIEWER:
      return `task-reviewer:${input.taskId}:${input.round}`;
    case ROLE_FINAL_STANDARDS:
      return `final-reviewer:${input.packageHash}:standards`;
    case ROLE_FINAL_SPEC:
      return `final-reviewer:${input.packageHash}:spec`;
    default:
      throw new Error(`dispatchKeyFor: unknown role ${role}`);
  }
}

function dispatchDir(commonDir, workflowId, dispatchKey) {
  return join(opencodeShipStateDir(commonDir), "runs", workflowId, "dispatch", dispatchKey);
}

async function dispatchPath(commonDir, workflowId, dispatchKey) {
  return join(dispatchDir(commonDir, workflowId, dispatchKey), "dispatch.json");
}

function hashPayload(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

/**
 * Persist a dispatch record at the prepared state.
 *
 * @param {string} repoRoot
 * @param {string} workflowId
 * @param {string} role
 * @param {object} keyInput
 * @param {object} payload
 * @returns {Promise<{ dispatchKey: string, dispatchPath: string, state: string }>}
 */
export async function prepareDispatch(repoRoot, workflowId, role, keyInput, payload) {
  if (!ROLE_KEYS.has(role)) {
    throw new Error(`prepareDispatch: unknown role ${role}`);
  }
  const common = await resolveGitCommonDir(repoRoot);
  const dispatchKey = dispatchKeyFor(role, keyInput);
  const commonDir = opencodeShipStateDir(common);
  const dir = dispatchDir(common, workflowId, dispatchKey);
  await mkdir(dir, { recursive: true });
  const path = await dispatchPath(common, workflowId, dispatchKey);
  const record = {
    workflowId,
    dispatchKey,
    role,
    keyInput,
    payloadHash: hashPayload(payload),
    state: "prepared",
    preparedAt: new Date().toISOString(),
  };
  await publishImmutableJson(path, record);
  return { dispatchKey, dispatchPath: path, state: "prepared" };
}

/**
 * Transition a dispatch record to the next state. Reads the
 * existing record, validates the transition, then publishes a
 * new immutable record at the next sequence under the same
 * dispatch directory. The first N events share a single
 * directory; each transition publishes a sibling sequence file
 * so the audit trail is append-only.
 *
 * @param {string} repoRoot
 * @param {string} workflowId
 * @param {string} dispatchKey
 * @param {string} nextState One of: created, prompted, completed, failed, orphaned.
 * @param {object} [fields]
 * @returns {Promise<object>} The new dispatch record.
 */
export async function transitionDispatch(repoRoot, workflowId, dispatchKey, nextState, fields = {}) {
  const common = await resolveGitCommonDir(repoRoot);
  const baseDir = join(opencodeShipStateDir(common), "runs", workflowId, "dispatch", dispatchKey);
  await mkdir(baseDir, { recursive: true });
  const next = Number(fields.sequence ?? 0);
  const path = join(baseDir, `seq-${String(next).padStart(6, "0")}.json`);
  const record = {
    workflowId,
    dispatchKey,
    state: nextState,
    ...fields,
    recordedAt: new Date().toISOString(),
  };
  await publishImmutableJson(path, record);
  return record;
}

/**
 * Read the latest immutable dispatch record for the given key.
 * Returns null when no record exists.
 *
 * @param {string} repoRoot
 * @param {string} workflowId
 * @param {string} dispatchKey
 * @returns {Promise<object | null>}
 */
export async function readLatestDispatch(repoRoot, workflowId, dispatchKey) {
  const { readdir, readFile } = await import("node:fs/promises");
  const common = await resolveGitCommonDir(repoRoot);
  const baseDir = join(opencodeShipStateDir(common), "runs", workflowId, "dispatch", dispatchKey);
  const { readdirSync, statSync } = await import("node:fs");
  if (!statSync(baseDir, { throwIfNoEntry: false })) return null;
  const files = readdirSync(baseDir).filter((f) => f.startsWith("seq-")).sort();
  if (files.length === 0) {
    const initial = join(baseDir, "dispatch.json");
    if (!statSync(initial, { throwIfNoEntry: false })) return null;
    return JSON.parse(await readFile(initial, "utf8"));
  }
  const last = files[files.length - 1];
  const raw = await readFile(join(baseDir, last), "utf8");
  return JSON.parse(raw);
}

async function readPreparedDispatch(repoRoot, workflowId, dispatchKey) {
  const { readFile } = await import("node:fs/promises");
  const common = await resolveGitCommonDir(repoRoot);
  const path = join(opencodeShipStateDir(common), "runs", workflowId, "dispatch", dispatchKey, "dispatch.json");
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Render the canonical dispatch key for a role + keyInput. The
 * helpers exposed via `dispatchKeyFor` keep the contract in one
 * place; consumers should prefer the role-specific exports below.
 */
export { dispatchKeyFor };

export const DISPATCH_KEY_PLANNER = ROLE_PLANNER;
export const DISPATCH_KEY_BUILDER = ROLE_BUILDER;
export const DISPATCH_KEY_TASK_REVIEWER = ROLE_TASK_REVIEWER;
export const DISPATCH_KEY_FINAL_STANDARDS = ROLE_FINAL_STANDARDS;
export const DISPATCH_KEY_FINAL_SPEC = ROLE_FINAL_SPEC;

/**
 * Dispatch protocol wrapper.
 *
 * OpenCode exposes generated SDK methods on the plugin context.
 * Requests use `{ body, path, query }` and responses use
 * `{ data, error }`; the dispatcher keeps that transport shape
 * explicit so qualification fakes cannot accidentally validate a
 * private, incompatible API.
 *
 * The wrapper:
 *   1. resolves the controller session lease for the workflow
 *   2. persists `prepared`
 *   3. calls `client.session.create` and persists `created`
 *   4. calls `client.session.promptAsync` and persists `prompted`
 *   5. returns the session id + final event sequence
 *
 * If any step throws, the dispatcher records the failure and
 * rethrows so the caller can fail closed.
 *
 * @param {object} input
 * @param {string} input.repoRoot
 * @param {string} input.workflowId
 * @param {string} input.role
 * @param {object} input.keyInput
 * @param {object} input.payload
 * @param {object} input.client An object exposing
 *   `session.create({ parentID, title })` and
 *   `session.promptAsync({ sessionID, parts })`.
 * @param {string} input.parentSessionID
 * @param {string} [input.titleMarker]
 * @param {string} [input.agent]
 * @param {string} [input.model] `<provider>/<model>`
 * @returns {Promise<{ sessionID: string, dispatchKey: string }>}
 */
export async function dispatchWorker(input) {
  const { repoRoot, workflowId, role, keyInput, payload, client, parentSessionID, titleMarker, agent, model } = input;
  if (!ROLE_KEYS.has(role)) {
    throw new Error(`dispatchWorker: unknown role ${role}`);
  }
  if (!client || typeof client.session?.create !== "function" || typeof client.session?.promptAsync !== "function") {
    throw new Error("dispatchWorker: client.session.create and client.session.promptAsync are required");
  }
  if (!parentSessionID || typeof parentSessionID !== "string") {
    throw new Error("dispatchWorker: parentSessionID required");
  }
  await assertControllerLease(repoRoot, workflowId, parentSessionID);
  const dispatchKey = dispatchKeyFor(role, keyInput);
  const common = await resolveGitCommonDir(repoRoot);
  const stateDir = opencodeShipStateDir(common);
  const preparedPayload = { ...payload, agent: agent ?? null, model: model ?? null };
  return withResourceLock(stateDir, `dispatch:${workflowId}:${dispatchKey}`, async () => {
    let latest = await readLatestDispatch(repoRoot, workflowId, dispatchKey);
    const preparedRecord = await readPreparedDispatch(repoRoot, workflowId, dispatchKey);
    if (preparedRecord && preparedRecord.payloadHash !== hashPayload(preparedPayload)) {
      throw new Error(`dispatchWorker: payload changed for existing dispatch ${dispatchKey}`);
    }
    if (latest?.state === "prompted" || latest?.state === "completed") {
      return { sessionID: latest.sessionID, dispatchKey };
    }
    if (!preparedRecord) {
      await prepareDispatch(repoRoot, workflowId, role, keyInput, preparedPayload);
      latest = { state: "prepared", sequence: 0 };
    }
    let sequence = Number(latest?.sequence ?? 0);
    const title = titleMarker ?? `ship-${role}-${dispatchKey}`;
    let sessionID = latest?.state === "created" ? latest.sessionID : null;
    if (!sessionID) {
      try {
        const created = await client.session.create({
          body: { parentID: parentSessionID, title },
          query: { directory: repoRoot },
        });
        if (created?.error) {
          throw new Error(`dispatchWorker: session.create failed: ${formatSdkError(created.error)}`);
        }
        const createdData = created?.data ?? created;
        sessionID = createdData?.id ?? createdData?.sessionID;
        if (!sessionID) {
          throw new Error(`dispatchWorker: client.session.create did not return a session id`);
        }
      } catch (err) {
        sequence += 1;
        await transitionDispatch(repoRoot, workflowId, dispatchKey, "failed", {
          sequence,
          lastError: `create: ${err?.message ?? err}`,
        });
        throw err;
      }
      sequence += 1;
      await transitionDispatch(repoRoot, workflowId, dispatchKey, "created", {
        sequence,
        sessionID,
        controllerSessionID: parentSessionID,
      });
    }
    try {
      const body = {
        parts: [{ type: "text", text: String(payload?.promptText ?? "") }],
      };
      if (agent) body.agent = agent;
      if (model) body.model = parseModelId(model);
      const prompted = await client.session.promptAsync({
        path: { id: sessionID },
        body,
        query: { directory: repoRoot },
      });
      if (prompted?.error) {
        throw new Error(`dispatchWorker: session.promptAsync failed: ${formatSdkError(prompted.error)}`);
      }
    } catch (err) {
      sequence += 1;
      await transitionDispatch(repoRoot, workflowId, dispatchKey, "failed", {
        sequence,
        sessionID,
        controllerSessionID: parentSessionID,
        lastError: `promptAsync: ${err?.message ?? err}`,
      });
      throw err;
    }
    sequence += 1;
    await transitionDispatch(repoRoot, workflowId, dispatchKey, "prompted", {
      sequence,
      sessionID,
      controllerSessionID: parentSessionID,
    });
    return { sessionID, dispatchKey };
  });
}

function parseModelId(value) {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    throw new Error(`dispatchWorker: model must be <provider>/<model>`);
  }
  return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) };
}

function formatSdkError(error) {
  if (typeof error === "string") return error;
  if (error && typeof error.message === "string") return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Write the immutable controller session lease. The lease is a
 * single JSON value under `<stateDir>/runs/<workflow>/controller.json`
 * that records the controller session id. The first lease wins;
 * a different ship-controller session calling `ship_resume`
 * takes over the lease atomically.
 *
 * @param {string} repoRoot
 * @param {string} workflowId
 * @param {string} controllerSessionID
 */
export async function issueControllerLease(repoRoot, workflowId, controllerSessionID) {
  const { atomicReplaceJson } = await import("../state/durable-store.js");
  const common = await resolveGitCommonDir(repoRoot);
  const path = join(opencodeShipStateDir(common), "runs", workflowId, "controller.json");
  await mkdir(dirnameOf(path), { recursive: true });
  await atomicReplaceJson(path, {
    workflowId,
    controllerSessionID,
    issuedAt: new Date().toISOString(),
  });
}

import { dirname as dirnameOf } from "node:path";

/**
 * Read the current controller session lease. Returns null when
 * no lease exists.
 *
 * @param {string} repoRoot
 * @param {string} workflowId
 * @returns {Promise<{ controllerSessionID: string, issuedAt: string } | null>}
 */
export async function readControllerLease(repoRoot, workflowId) {
  const { readFile } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const common = await resolveGitCommonDir(repoRoot);
  const path = join(opencodeShipStateDir(common), "runs", workflowId, "controller.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Authorization primitive for controller tools. The supplied
 * ToolContext must match the active controller lease exactly.
 *
 * @param {string} repoRoot
 * @param {string} workflowId
 * @param {{ sessionID?: string, agent?: string } | null | undefined} ctx
 * @returns {Promise<{ ok: true, sessionID: string, message: string } | { ok: false, kind: string, message: string }>}
 */
export async function authorizeControllerCall(repoRoot, workflowId, ctx) {
  const lease = await readControllerLease(repoRoot, workflowId);
  if (!lease) {
    return { ok: false, kind: "no-lease", message: "controller lease not issued; ship_plan_start must run first" };
  }
  if (!ctx || typeof ctx.sessionID !== "string") {
    return { ok: false, kind: "no-session", message: "ToolContext.sessionID required" };
  }
  if (ctx.sessionID !== lease.controllerSessionID) {
    return { ok: false, kind: "lease-mismatch", message: `ToolContext.sessionID (${ctx.sessionID.slice(0, 8)}) does not match controller lease (${lease.controllerSessionID.slice(0, 8)})` };
  }
  if (ctx.agent && ctx.agent !== "ship-controller") {
    return { ok: false, kind: "wrong-agent", message: `ToolContext.agent (${ctx.agent}) is not ship-controller` };
  }
  return { ok: true, sessionID: lease.controllerSessionID, message: "controller lease matched" };
}

/**
 * Authorization primitive for worker tools. The worker's
 * `ctx.sessionID` must match the latest persisted dispatch
 * session for the supplied role + key tuple.
 *
 * @param {string} repoRoot
 * @param {string} workflowId
 * @param {string} role
 * @param {object} keyInput
 * @param {{ sessionID?: string, agent?: string } | null | undefined} ctx
 * @returns {Promise<{ ok: true, sessionID: string, dispatchKey: string, message: string } | { ok: false, kind: string, message: string }>}
 */
export async function authorizeChildCall(repoRoot, workflowId, role, keyInput, ctx) {
  if (!ROLE_KEYS.has(role)) {
    return { ok: false, kind: "unknown-role", message: `unknown role ${role}` };
  }
  const dispatchKey = dispatchKeyFor(role, keyInput);
  const latest = await readLatestDispatch(repoRoot, workflowId, dispatchKey);
  if (!latest) {
    return { ok: false, kind: "no-dispatch", message: `no dispatch record for ${role} ${dispatchKey}` };
  }
  if (!latest.sessionID) {
    return { ok: false, kind: "no-session", message: `dispatch ${dispatchKey} has no session id` };
  }
  if (!ctx || typeof ctx.sessionID !== "string") {
    return { ok: false, kind: "no-session", message: "ToolContext.sessionID required" };
  }
  if (ctx.sessionID !== latest.sessionID) {
    return { ok: false, kind: "session-mismatch", message: `ToolContext.sessionID (${ctx.sessionID.slice(0, 8)}) does not match dispatch session (${latest.sessionID.slice(0, 8)})` };
  }
  if (latest.state !== "created" && latest.state !== "prompted" && latest.state !== "completed") {
    return { ok: false, kind: "bad-state", message: `dispatch ${dispatchKey} is in state ${latest.state}` };
  }
  return { ok: true, sessionID: latest.sessionID, dispatchKey, message: "dispatch session matched" };
}

/**
 * Acquire the per-workflow controller lease. Wraps
 * `withResourceLock` so concurrent controllers serialise.
 *
 * @template T
 * @param {string} repoRoot
 * @param {string} workflowId
 * @param {string} controllerSessionID
 * @param {() => Promise<T>} callback
 * @returns {Promise<T>}
 */
export async function withControllerLease(repoRoot, workflowId, controllerSessionID, callback) {
  const common = await resolveGitCommonDir(repoRoot);
  const lockKey = `controller:${workflowId}`;
  return withResourceLock(opencodeShipStateDir(common), lockKey, async () => {
    await issueControllerLease(repoRoot, workflowId, controllerSessionID);
    return callback();
  });
}

/**
 * Internal: assert the controller session lease matches
 * `parentSessionID` before any dispatch. Called at the top of
 * `dispatchWorker` so unauthorised callers fail closed before
 * any dispatch record is written.
 *
 * @param {string} repoRoot
 * @param {string} workflowId
 * @param {string} controllerSessionID
 */
async function assertControllerLease(repoRoot, workflowId, controllerSessionID) {
  const lease = await readControllerLease(repoRoot, workflowId);
  if (!lease) {
    throw new Error(`assertControllerLease: controller lease not issued for ${workflowId}; call ship_plan_start first`);
  }
  if (lease.controllerSessionID !== controllerSessionID) {
    throw new Error(`assertControllerLease: parent session (${controllerSessionID.slice(0, 8)}) does not hold the lease (${lease.controllerSessionID.slice(0, 8)})`);
  }
}

export const ROLES = Object.freeze({
  PLANNER: ROLE_PLANNER,
  BUILDER: ROLE_BUILDER,
  TASK_REVIEWER: ROLE_TASK_REVIEWER,
  FINAL_STANDARDS: ROLE_FINAL_STANDARDS,
  FINAL_SPEC: ROLE_FINAL_SPEC,
});
