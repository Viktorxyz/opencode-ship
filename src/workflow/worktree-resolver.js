import { listManifests } from "../state/manifest-store.js";
import { validateLinkedWorktree } from "../skills/worktree.js";
import { readPlanRevision } from "./plan-store.js";
import { readRunState } from "./run-controller.js";

function failureRecord(kind, details = {}) {
  return { ok: false, kind, ...details };
}

/**
 * Resolve a durable workflow to its single registered implementation worktree.
 * Expected linkage failures are returned as records; corrupt durable state may
 * still throw from the underlying stores.
 *
 * @param {string} repoRoot
 * @param {string} workflowId
 */
export async function resolveWorkflowWorktree(repoRoot, workflowId) {
  const runState = await readRunState(repoRoot, workflowId);
  if (!runState) {
    return failureRecord("missing-workflow-run", { workflowId });
  }

  const planRecord = await readPlanRevision(repoRoot, workflowId, runState.revision);
  if (!planRecord) {
    return failureRecord("missing-workflow-plan", {
      workflowId,
      revision: runState.revision,
    });
  }
  if (planRecord.hash !== runState.sha256) {
    return failureRecord("workflow-plan-mismatch", {
      workflowId,
      revision: runState.revision,
      expected: runState.sha256,
      received: planRecord.hash,
    });
  }

  const issueNumber = planRecord.plan?.source?.issueNumber;
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return failureRecord("missing-workflow-issue", {
      workflowId,
      revision: runState.revision,
    });
  }

  const matches = (await listManifests(repoRoot))
    .filter((manifest) => manifest.issueNumber === issueNumber);
  if (matches.length !== 1) {
    return failureRecord("ambiguous-workflow-manifest", {
      issueNumber,
      count: matches.length,
    });
  }

  const manifest = matches[0];
  if (manifest.schemaVersion !== 2) {
    return failureRecord("workflow-mismatch", {
      expectedSchema: 2,
      receivedSchema: manifest.schemaVersion,
    });
  }
  if (manifest.workflowId !== workflowId) {
    return failureRecord("workflow-mismatch", {
      expected: workflowId,
      received: manifest.workflowId,
    });
  }
  if (!manifest.worktreePath) {
    return failureRecord("missing-worktree-path", { taskId: manifest.taskId });
  }

  const linked = await validateLinkedWorktree(repoRoot, manifest.worktreePath, {
    allowCurrentLinked: true,
  });
  if (!linked.ok) {
    return failureRecord("invalid-worktree", {
      reason: linked.kind,
      message: linked.message,
    });
  }

  return {
    ok: true,
    workflowId,
    issueNumber,
    manifest,
    worktreePath: linked.path,
  };
}
