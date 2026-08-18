/**
 * Run reducer + deterministic controller entry.
 *
 * Single source of truth for the workflow state machine. The
 * reducer is pure: every transition takes the current state
 * and an event, returns the next state and any side ledger
 * entry. The controller wraps the reducer with the I/O that
 * inverts the ledger back into the Git common directory.
 *
 * Transitions:
 *   created     -> running
 *   running     -> running (task dispatched)
 *   running     -> commit-pending (review passes)
 *   running     -> fix-pending (review fails; round++)
 *   running     -> revision-required (3 consecutive failures)
 *   running     -> blocked (unrecoverable infrastructure failure)
 *   commit-pending -> committed (controller commits and writes ledgers)
 *   committed   -> running (next task dispatched)
 *   running     -> all-tasks-done
 *   all-tasks-done -> ready-pending (final review)
 *   ready-pending -> ready (parallel Standards/Spec + verification)
 *   ready       -> merged (separate explicit merge)
 *   merged      -> done
 *
 * Invariant: at most one task is active at any time. The
 * reducer refuses to advance from "running" with a different
 * task id than the one already recorded.
 *
 * Every recorded event is hash-chained: each event carries the
 * SHA-256 of the previous event's bytes and the SHA-256 of its
 * own canonical bytes. A corrupted or reordered ledger is
 * detected by replaying the chain.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveGitCommonDir, opencodeShipStateDir } from "../state/git-common-dir.js";
import { publishImmutableJson, withResourceLock } from "../state/durable-store.js";

async function readSnapshotFromDisk(repoRoot, workflowId) {
  const common = await resolveGitCommonDir(repoRoot);
  const runPath = join(opencodeShipStateDir(common), "runs", workflowId, "run.json");
  if (!existsSync(runPath)) return null;
  try {
    const raw = await readFile(runPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readEventsFromDisk(repoRoot, workflowId) {
  const common = await resolveGitCommonDir(repoRoot);
  const dir = join(opencodeShipStateDir(common), "runs", workflowId, "events");
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir);
  const sorted = entries.filter((n) => n.endsWith(".json")).sort();
  const out = [];
  for (const name of sorted) {
    const raw = await readFile(join(dir, name), "utf8");
    out.push(JSON.parse(raw));
  }
  return out;
}

const STATES = Object.freeze({
  CREATED: "created",
  RUNNING: "running",
  COMMIT_PENDING: "commit-pending",
  COMMITTED: "committed",
  FIX_PENDING: "fix-pending",
  REVISION_REQUIRED: "revision-required",
  BLOCKED: "blocked",
  ALL_TASKS_DONE: "all-tasks-done",
  READY_PENDING: "ready-pending",
  READY: "ready",
  MERGED: "merged",
  DONE: "done",
});

const EVENT_KINDS = Object.freeze({
  RUN_START: "run-start",
  TASK_DISPATCH: "task-dispatch",
  TASK_REPORT: "task-report",
  TASK_REVIEW: "task-review",
  COMMIT: "commit",
  TASK_COMPLETE: "task-complete",
  ALL_TASKS_DONE: "all-tasks-done",
  FINAL_REVIEW: "final-review",
  READY_PENDING: "ready-pending",
  READY: "ready",
  MERGE: "merge",
  DONE: "done",
  BLOCKED: "blocked",
});

const MAX_FIX_ROUNDS = 3;

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalize(value) {
  const seen = new WeakSet();
  const sort = (v) => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v)) return null;
    seen.add(v);
    if (Array.isArray(v)) return v.map(sort);
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sort(v[k]);
    return out;
  };
  return JSON.stringify(sort(value));
}

function nextRound(failures) {
  return (failures ?? 0) + 1;
}

function nextSequence(events) {
  return events.length + 1;
}

function appendEvent(state, recorded) {
  const prev = state.events[state.events.length - 1];
  const priorHash = prev?.hash ?? "0".repeat(64);
  const hash = sha256(canonicalize({ kind: recorded.kind, data: recorded.data, at: recorded.at, sequence: recorded.sequence, priorHash }));
  const withHash = { ...recorded, priorHash, hash };
  return [...state.events, withHash];
}

function normalizeState(state) {
  // Defensive: the reducer expects completedTasks and taskReady
  // to be defined. Snapshots always carry them, but a snapshot
  // reloaded from on-disk events can be missing fields if the
  // recorded event was written by a different code path.
  return {
    ...state,
    completedTasks: Array.isArray(state.completedTasks) ? state.completedTasks : [],
    taskReady: state.taskReady ?? null,
    events: Array.isArray(state.events) ? state.events : [],
    round: Number.isInteger(state.round) ? state.round : 0,
    failures: Number.isInteger(state.failures) ? state.failures : 0,
  };
}

function ensureActiveTask(state, taskId) {
  if (state.activeTask === null) return;
  if (state.activeTask !== taskId) {
    throw new Error(`run reducer: another task is active (${state.activeTask}), refusing ${taskId}`);
  }
}

/**
 * Pure reducer. Returns the next state and the event to
 * append to the immutable ledger. Never throws on a valid
 * transition; the controller catches out-of-order calls.
 *
 * @param {object} state
 * @param {object} event
 * @returns {{ state: object, event: object }}
 */
export function reduce(state, event) {
  const ev = { ...event, at: event.at ?? new Date().toISOString() };
  const sequence = nextSequence(state.events);
  const recorded = (kind, data) => ({ sequence, kind, at: ev.at, data });
  const nextState = (extra) => ({ ...state, ...extra, events: appendEvent(state, recorded(event.kind, event.data)) });
  switch (event.kind) {
    case EVENT_KINDS.RUN_START: {
      if (state.state !== STATES.CREATED) {
        throw new Error(`run reducer: RUN_START requires state=created, got ${state.state}`);
      }
      return {
        state: nextState({ state: STATES.RUNNING, activeTask: null, round: 0, completedTasks: [] }),
        event: recorded(EVENT_KINDS.RUN_START, { revision: event.data.revision, sha256: event.data.sha256 }),
      };
    }
    case EVENT_KINDS.TASK_DISPATCH: {
      if (state.state !== STATES.RUNNING && state.state !== STATES.FIX_PENDING) {
        throw new Error(`run reducer: TASK_DISPATCH requires state=running|fix-pending, got ${state.state}`);
      }
      if (state.activeTask !== null) {
        throw new Error(`run reducer: TASK_DISPATCH while another task is active (${state.activeTask})`);
      }
      // A fix round preserves the round counter; the very first
      // dispatch starts at round 1. The task id stays the same so
      // the reducer's at-most-one-active-task invariant holds.
      const round = state.round > 0 ? state.round : 1;
      return {
        state: nextState({ state: STATES.RUNNING, activeTask: event.data.taskId, round }),
        event: recorded(EVENT_KINDS.TASK_DISPATCH, { taskId: event.data.taskId, briefHash: event.data.briefHash, round }),
      };
    }
    case EVENT_KINDS.TASK_REPORT: {
      if ((state.state !== STATES.RUNNING && state.state !== STATES.FIX_PENDING) || state.activeTask === null) {
        throw new Error(`run reducer: TASK_REPORT requires running with active task`);
      }
      ensureActiveTask(state, event.data.taskId);
      // The builder's report transitions the task to "review
      // pending" — the next event must be TASK_REVIEW. Round
      // does NOT advance on report; only failed verdicts consume
      // a round.
      return {
        state: nextState({ state: STATES.RUNNING, taskReady: { taskId: event.data.taskId, reportHash: event.data.reportHash } }),
        event: recorded(EVENT_KINDS.TASK_REPORT, { taskId: event.data.taskId, reportHash: event.data.reportHash }),
      };
    }
    case EVENT_KINDS.TASK_REVIEW: {
      if ((state.state !== STATES.RUNNING && state.state !== STATES.FIX_PENDING) || state.activeTask === null) {
        throw new Error(`run reducer: TASK_REVIEW requires running with active task`);
      }
      ensureActiveTask(state, event.data.taskId);
      const failures = event.data.verdict === "pass" ? 0 : nextRound(state.failures);
      if (event.data.verdict === "pass") {
        return {
          state: nextState({ state: STATES.COMMIT_PENDING, round: state.round, taskReady: { ...(state.taskReady ?? {}), taskId: event.data.taskId, reviewHash: event.data.reviewHash } }),
          event: recorded(EVENT_KINDS.TASK_REVIEW, { taskId: event.data.taskId, verdict: "pass", reviewHash: event.data.reviewHash }),
        };
      }
      const next = nextRound(state.round);
      if (failures >= MAX_FIX_ROUNDS) {
        return {
          state: nextState({ state: STATES.REVISION_REQUIRED, failures, round: next, activeTask: null }),
          event: recorded(EVENT_KINDS.TASK_REVIEW, { taskId: event.data.taskId, verdict: "fail", failures }),
        };
      }
      return {
        state: nextState({ state: STATES.FIX_PENDING, failures, round: next, activeTask: null, taskReady: null }),
        event: recorded(EVENT_KINDS.TASK_REVIEW, { taskId: event.data.taskId, verdict: "fail", round: next, failures }),
      };
    }
    case EVENT_KINDS.COMMIT: {
      if (state.state !== STATES.COMMIT_PENDING) {
        throw new Error(`run reducer: COMMIT requires state=commit-pending, got ${state.state}`);
      }
      const taskId = state.taskReady?.taskId;
      // completedTasks is appended exactly once here (COMMIT). The
      // TASK_COMPLETE handler must not duplicate the entry.
      const completedTasks = taskId
        ? state.completedTasks.includes(taskId)
          ? state.completedTasks
          : [...state.completedTasks, taskId]
        : state.completedTasks;
      return {
        state: nextState({ state: STATES.COMMITTED, activeTask: null, round: 0, failures: 0, completedTasks }),
        event: recorded(EVENT_KINDS.COMMIT, { taskId, commitSha: event.data.commitSha }),
      };
    }
    case EVENT_KINDS.TASK_COMPLETE: {
      if (state.state !== STATES.COMMITTED) {
        throw new Error(`run reducer: TASK_COMPLETE requires state=committed, got ${state.state}`);
      }
      // Default behaviour: stay in RUNNING so the next task can
      // dispatch immediately. Explicit `moreTasks: false` signals
      // that the plan has no more tasks and we should advance to
      // ALL_TASKS_DONE for the final review.
      const moreTasks = event.data.moreTasks === false ? false : true;
      const nextStateObj = moreTasks
        ? { state: STATES.RUNNING, activeTask: null, taskReady: null, round: 0, failures: 0 }
        : { state: STATES.ALL_TASKS_DONE, activeTask: null, taskReady: null };
      return {
        state: nextState(nextStateObj),
        event: recorded(EVENT_KINDS.TASK_COMPLETE, { taskId: event.data.taskId, moreTasks, nextTaskId: event.data.nextTaskId ?? null }),
      };
    }
    case EVENT_KINDS.FINAL_REVIEW: {
      if (state.state !== STATES.ALL_TASKS_DONE && state.state !== STATES.READY_PENDING) {
        throw new Error(`run reducer: FINAL_REVIEW requires state=all-tasks-done|ready-pending, got ${state.state}`);
      }
      // Two axes (Standards + Spec) must both be recorded before
      // Ready. The reducer collects them via event.data.axis.
      // Both axes must agree on the same immutable package hash,
      // HEAD, and merge-base SHA. A drift invalidates the package.
      const incomingHash = event.data.packageHash;
      const incomingHead = event.data.headSha;
      const incomingMergeBase = event.data.mergeBaseSha;
      const finalReview = { ...(state.finalReview ?? {}) };
      if (state.state === STATES.ALL_TASKS_DONE) {
        finalReview.packageHash = incomingHash;
        finalReview.headSha = incomingHead;
        finalReview.mergeBaseSha = incomingMergeBase;
      } else {
        if (finalReview.packageHash !== incomingHash) {
          throw new Error(`run reducer: FINAL_REVIEW axis ${event.data.axis} disagrees with package hash`);
        }
        if (finalReview.headSha !== incomingHead) {
          throw new Error(`run reducer: FINAL_REVIEW axis ${event.data.axis} disagrees with HEAD`);
        }
        if (finalReview.mergeBaseSha !== incomingMergeBase) {
          throw new Error(`run reducer: FINAL_REVIEW axis ${event.data.axis} disagrees with merge-base`);
        }
      }
      finalReview[event.data.axis] = event.data.review;
      return {
        state: nextState({
          state: STATES.READY_PENDING,
          finalReview,
        }),
        event: recorded(EVENT_KINDS.FINAL_REVIEW, {
          axis: event.data.axis,
          verdict: event.data.verdict,
          headSha: incomingHead,
          mergeBaseSha: incomingMergeBase,
          packageHash: incomingHash,
          sessionID: event.data.sessionID,
          review: event.data.review,
        }),
      };
    }
    case EVENT_KINDS.READY: {
      if (state.state !== STATES.COMMITTED && state.state !== STATES.READY_PENDING) {
        throw new Error(`run reducer: READY requires state=committed|ready-pending, got ${state.state}`);
      }
      if (state.state === STATES.READY_PENDING && (!state.finalReview?.standards || !state.finalReview?.spec)) {
        throw new Error(`run reducer: READY requires both Standards and Spec final reviews`);
      }
      // READY must match the final-review HEAD; CI and verifier
      // bind to this same SHA before merge.
      if (state.state === STATES.READY_PENDING && state.finalReview.headSha && event.data.headSha && state.finalReview.headSha !== event.data.headSha) {
        throw new Error(`run reducer: READY head drift (finalReview=${state.finalReview.headSha.slice(0,8)}, ready=${event.data.headSha.slice(0,8)})`);
      }
      return {
        state: nextState({ state: STATES.READY, activeTask: null, completedTasks: state.completedTasks }),
        event: recorded(EVENT_KINDS.READY, { headSha: event.data.headSha }),
      };
    }
    case EVENT_KINDS.MERGE: {
      if (state.state !== STATES.READY) {
        throw new Error(`run reducer: MERGE requires state=ready, got ${state.state}`);
      }
      return {
        state: nextState({ state: STATES.MERGED, mergedAt: ev.at, mergeSha: event.data.mergeSha }),
        event: recorded(EVENT_KINDS.MERGE, { mergeSha: event.data.mergeSha }),
      };
    }
    case EVENT_KINDS.DONE: {
      if (state.state !== STATES.MERGED) {
        throw new Error(`run reducer: DONE requires state=merged, got ${state.state}`);
      }
      return {
        state: nextState({ state: STATES.DONE, activeTask: null }),
        event: recorded(EVENT_KINDS.DONE, { taskId: event.data.taskId }),
      };
    }
    case EVENT_KINDS.BLOCKED: {
      return {
        state: nextState({ state: STATES.BLOCKED, blockedReason: event.data.reason }),
        event: recorded(EVENT_KINDS.BLOCKED, { reason: event.data.reason }),
      };
    }
    default:
      throw new Error(`run reducer: unknown event kind ${event.kind}`);
  }
}

export function createInitialState(workflowId, revision, sha256) {
  return {
    workflowId,
    revision,
    sha256,
    state: STATES.CREATED,
    activeTask: null,
    taskReady: null,
    round: 0,
    failures: 0,
    completedTasks: [],
    events: [],
  };
}

export const RUN_STATES = STATES;
export const RUN_EVENT_KINDS = EVENT_KINDS;
export const RUN_MAX_FIX_ROUNDS = MAX_FIX_ROUNDS;

function snapshotFields(state) {
  return {
    workflowId: state.workflowId,
    revision: state.revision,
    sha256: state.sha256,
    state: state.state,
    activeTask: state.activeTask,
    taskReady: state.taskReady ?? null,
    failures: state.failures,
    round: state.round,
    completedTasks: state.completedTasks,
    finalReview: state.finalReview ?? null,
  };
}

function replayPersistedRun(workflowId, snapshot, events) {
  if (!snapshot || events.length === 0) {
    throw new Error("run state has no immutable event ledger");
  }
  const first = events[0];
  if (first.kind !== EVENT_KINDS.RUN_START) {
    throw new Error("run event ledger must begin with run-start");
  }
  let state = createInitialState(workflowId, first.data?.revision, first.data?.sha256);
  let priorHash = "0".repeat(64);
  for (let index = 0; index < events.length; index += 1) {
    const persisted = events[index];
    if (persisted.sequence !== index + 1 || persisted.priorHash !== priorHash) {
      throw new Error(`run event ledger chain mismatch at sequence ${index + 1}`);
    }
    const expectedHash = sha256(canonicalize({
      kind: persisted.kind,
      data: persisted.data,
      at: persisted.at,
      sequence: persisted.sequence,
      priorHash,
    }));
    if (persisted.hash !== expectedHash) {
      throw new Error(`run event ledger hash mismatch at sequence ${index + 1}`);
    }
    const reduced = reduce(state, { kind: persisted.kind, data: persisted.data, at: persisted.at });
    const replayedEvent = reduced.state.events.at(-1);
    if (replayedEvent.hash !== persisted.hash) {
      throw new Error(`run event ledger replay mismatch at sequence ${index + 1}`);
    }
    state = reduced.state;
    priorHash = persisted.hash;
  }
  if (canonicalize(snapshotFields(state)) !== canonicalize(snapshotFields(snapshot))) {
    throw new Error("run snapshot does not match immutable event ledger");
  }
  return state;
}

async function runDir(repoRoot, workflowId) {
  const common = await resolveGitCommonDir(repoRoot);
  return join(opencodeShipStateDir(common), "runs", workflowId);
}

function readTaskId(baseHead, planHash) {
  return sha256(`${planHash}:${baseHead}`).slice(0, 16);
}

/**
 * Append a single event to the immutable ledger and update
 * the run.json snapshot. The reducer is run inside a per-run
 * lock so concurrent controller invocations cannot interleave.
 *
 * @param {string} repoRoot
 * @param {string} workflowId
 * @param {object} state
 * @param {object} event
 * @returns {Promise<{ state: object, event: object }>}
 */
export async function appendRunEvent(repoRoot, workflowId, state, event) {
  const common = await resolveGitCommonDir(repoRoot);
  const dir = join(opencodeShipStateDir(common), "runs", workflowId, "events");
  await mkdir(dir, { recursive: true });
  const lockKey = `run:${workflowId}`;
  return withResourceLock(opencodeShipStateDir(common), lockKey, async () => {
    // Reload the actual event ledger + snapshot inside the
    // lock so the sequence is monotonically global to the run
    // and the snapshot's completedTasks / taskReady are not
    // lost when the controller continues from a disk-only
    // re-load.
    const persistedEvents = await readEventsFromDisk(repoRoot, workflowId);
    const persistedSnapshot = await readSnapshotFromDisk(repoRoot, workflowId);
    const liveState = persistedEvents.length > 0
      ? replayPersistedRun(workflowId, persistedSnapshot, persistedEvents)
      : normalizeState(state);
    const { state: next, event: recorded } = reduce(liveState, event);
    const chainedEvent = next.events.at(-1);
    const sequence = String(recorded.sequence).padStart(8, "0");
    const path = join(dir, `${sequence}.json`);
    await publishImmutableJson(path, chainedEvent);
    const runPath = join(opencodeShipStateDir(common), "runs", workflowId, "run.json");
    const snapshot = {
      ...snapshotFields(next),
      lastEvent: chainedEvent,
      updatedAt: new Date().toISOString(),
    };
    await writeFile(runPath, JSON.stringify(snapshot, null, 2), "utf8");
    return { state: next, event: chainedEvent };
  });
}

/**
 * Read the run state for a workflow. The snapshot is the
 * latest run.json; the events list is reconstructed from the
 * `events/` directory.
 *
 * @param {string} repoRoot
 * @param {string} workflowId
 * @returns {Promise<object | null>}
 */
export async function readRunState(repoRoot, workflowId) {
  const dir = await runDir(repoRoot, workflowId);
  const runPath = join(dir, "run.json");
  if (!existsSync(runPath)) return null;
  const snapshot = JSON.parse(await readFile(runPath, "utf8"));
  const eventsDir = join(dir, "events");
  const events = existsSync(eventsDir)
    ? await Promise.all(
        (await readdir(eventsDir))
          .filter((n) => n.endsWith(".json"))
          .sort()
          .map(async (n) => JSON.parse(await readFile(join(eventsDir, n), "utf8")))
      )
    : [];
  return replayPersistedRun(workflowId, snapshot, events);
}

export function buildCommitTrailers({ workflowId, planHash, taskId, round, reviewHash }) {
  return [
    `Opencode-Ship-Workflow: ${workflowId}`,
    `Opencode-Ship-Plan: ${planHash}`,
    `Opencode-Ship-Task: ${taskId}`,
    `Opencode-Ship-Review: ${reviewHash ?? "n/a"}`,
    `Opencode-Ship-Round: ${round}`,
  ];
}

export { readTaskId };
