/*
 * opencode-ship plugin entry point.
 *
 * Registered when opencode auto-discovers `.opencode/plugins/opencode-ship.js`
 * (no consumer-side wrapper) or when shipped as the `opencode-ship` npm
 * package. The plugin does not assume a hard-coded repository, owner,
 * or model; every value is resolved at runtime from the consumer
 * project's own `.opencode/ship.config.json` (falling back to
 * autodetection when the file is missing).
 *
 * The plugin exposes the canonical nine `delivery_*` typed tools and
 * relays every execute call to the existing core factories. Plugin
 * startup performs no writes other than a best-effort retry of the
 * `cleanupPending` queue tracked in `.opencode/ship.lock.json`.
 */

import { tool } from "@opencode-ai/plugin/tool";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { loadAdapter } from "./adapter.js";
import { createGhDriver } from "./drivers/gh-cli.js";
import {
  createInspectTool,
  createIssueTool,
  createWorktreeTool,
  createVerifyTool,
  createReviewTool,
  createPrTool,
  createReadyTool,
  createMergeTool,
  createCleanupTool,
  createGithubReadTool,
  createIssueCommentTool,
  createIssueLabelsTool,
  createIssueLinkTool,
  createIssueCloseTool,
  createSyncTool,
  createPublishTool,
  createPlanStartTool,
  createPlanSubmitTool,
  createPlanApproveTool,
  createRunStartTool,
  createTaskStartTool,
  createTaskCommitTool,
  createTaskCompleteTool,
  createTaskReportTool,
  createTaskReviewTool,
  createFinalReviewTool,
  createResumeTool,
  createStatusTool,
  createSkillDiscoverTool,
  createSkillInstallTool,
  createSkillAuditTool,
  createSkillUninstallTool,
} from "./tools/index.js";
import { recoverManifestAfterCrash } from "./recovery.js";
import { reconcileOwner } from "./installer/plugin-owner.js";
import { loadConfig, renderDefaultConfig, configPath } from "./installer/config.js";
import { readLock } from "./installer/lock.js";
import { detectProject } from "./installer/detection/project.js";
import { tryImmediateCleanup, listPending } from "./installer/cleanup.js";
import { flattenShipConfig } from "./installer/ship-adapter.js";
import { PACKAGE_VERSION } from "./version.js";

const toolDefs = [
  ["delivery_inspect", "Inspect a manifest and a project-local doctor report.", "inspect"],
  ["delivery_issue", "Find or create the issue for a delivery task.", "issue"],
  ["delivery_worktree", "Create an isolated worktree for the task.", "worktree"],
  ["delivery_verify", "Run the consumer's canonical verification command.", "verify"],
  ["delivery_review", "Record the reviewer verdict against the PR head SHA.", "review"],
  ["delivery_pr", "Open a draft PR linked to the issue.", "pr"],
  ["delivery_ready", "Mark the PR ready after every required gate has passed.", "ready"],
  ["delivery_merge", "Squash merge the PR after an explicit user request.", "merge"],
  ["delivery_cleanup", "Remove the agent-owned worktree and branch after merge.", "cleanup"],
  ["delivery_github_read", "Typed read of issue, PR, or check data.", "githubRead"],
  ["delivery_issue_comment", "Idempotent typed comment on an issue.", "issueComment"],
  ["delivery_issue_labels", "Idempotent label add/remove on an issue.", "issueLabels"],
  ["delivery_issue_link", "Mark a relationship between two issues.", "issueLink"],
  ["delivery_issue_close", "Close an issue with a recorded user permission subject.", "issueClose"],
  ["delivery_sync", "Fetch and merge base into the feature branch.", "sync"],
  ["delivery_publish", "Push the manifest branch to origin with HEAD verification.", "publish"],
  ["ship_plan_start", "Create a workflow and dispatch the configured planner.", "planStart"],
  ["ship_plan_submit", "Planner-only immutable PlanV2 submission.", "planSubmit"],
  ["ship_plan_approve", "Interactive approval + immutable local seal.", "planApprove"],
  ["ship_run_start", "Start execution of an approved plan.", "runStart"],
  ["ship_task_start", "Dispatch a task to the configured builder agent.", "taskStart"],
  ["ship_task_commit", "Record the immutable commit binding for a reviewed task.", "taskCommit"],
  ["ship_task_complete", "Advance the run to the next task or to ALL_TASKS_DONE.", "taskComplete"],
  ["ship_task_report", "Builder-only immutable task report.", "taskReport"],
  ["ship_task_review", "Task reviewer Spec/Quality verdict.", "taskReview"],
  ["ship_final_review", "Record one final review axis (standards or spec).", "finalReview"],
  ["ship_resume", "Restore, reconcile, and continue idempotently.", "resume"],
  ["ship_status", "Read-only compact workflow state.", "status"],
  ["ship_skill_discover", "Query the trusted skill registry and partition candidates.", "skillDiscover"],
  ["ship_skill_install", "Install a trusted skill into the active issue worktree.", "skillInstall"],
  ["ship_skill_audit", "Audit the installed trusted skills inventory.", "skillAudit"],
  ["ship_skill_uninstall", "Remove a trusted skill whose recorded sha256 still matches.", "skillUninstall"],
];

function wrapEnvelopeV2(id, result) {
  if (result && typeof result === "object" && result.contractVersion === 2) {
    return result;
  }
  if (result && typeof result === "object" && result.contractVersion === 1) {
    const { contractVersion: _cv, ...rest } = result;
    return {
      contractVersion: 2,
      ok: true,
      kind: id,
      operationId: `legacy-${Date.now().toString(36)}`,
      idempotent: false,
      data: rest,
    };
  }
  if (result && typeof result === "object" && typeof result.kind === "string") {
    return {
      contractVersion: 2,
      ok: false,
      kind: id,
      operationId: `legacy-${Date.now().toString(36)}`,
      retryable: false,
      message: result.kind,
      details: result,
    };
  }
  return {
    contractVersion: 2,
    ok: true,
    kind: id,
    operationId: `legacy-${Date.now().toString(36)}`,
    idempotent: false,
    data: result,
  };
}

function makeTool(id, description, factory, runtime) {
  return tool({
    description,
    args: factory.args,
    async execute(args, ctx) {
      const runner = factory.build(runtime, ctx);
      const env = await runner(args);
      const wrapped = wrapEnvelopeV2(id, env);
      return JSON.stringify(wrapped, null, 2);
    },
  });
}

async function resolveRepoSlug(repoRoot, detection, config) {
  const fromConfig = config?.value?.project?.repository;
  if (typeof fromConfig === "string" && fromConfig.includes("/")) return fromConfig;
  if (detection?.repository) return detection.repository;
  const gitConfig = await readFile(resolve(repoRoot, ".git/config"), "utf8").catch(() => null);
  if (gitConfig) {
    const m = gitConfig.match(/url\s*=\s*.*?github\.com[:/]([^/]+)\/([^/\s]+?)(?:\.git)?\b/);
    if (m) return `${m[1]}/${m[2]}`;
  }
  return null;
}

async function resolveOwner(repoRoot, detection, config, adapter) {
  const explicit = config?.value?.owner;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  return reconcileOwner(repoRoot, adapter);
}

function shippingLockValue(repoRoot) {
  return readLock(repoRoot);
}

async function bestEffortCleanupQueue(repoRoot, adapter) {
  const lock = await shippingLockValue(repoRoot);
  const pending = lock?.cleanupPending ?? [];
  const out = { reconciled: 0, retained: 0, failures: [] };
  const tasks = await listPending(repoRoot).catch(() => []);
  for (const manifest of tasks) {
    const r = await tryImmediateCleanup({ repoRoot, taskId: manifest.taskId, adapter });
    if (r.ok) out.reconciled += 1;
    else {
      out.retained += 1;
      const reason = (r && typeof r === "object" && "reason" in r) ? r.reason : "unknown";
      out.failures.push({ taskId: manifest.taskId, reason: reason ?? "unknown" });
    }
  }
  return { pending, manifestTasks: tasks.map((t) => t.taskId), ...out };
}

async function buildRuntime(worktree) {
  const repoRootAbs = resolve(worktree ?? process.cwd());
  const detection = detectProject(repoRootAbs);
  const legacyAdapter = await loadAdapter(repoRootAbs);
  const config = await loadConfig(repoRootAbs);
  const configValue = config?.ok ? config.value : renderDefaultConfig(detection);
  const shipAdapter = flattenShipConfig(configValue);
  const adapter = legacyAdapter.ok ? legacyAdapter.adapter : shipAdapter;
  const repoSlug = await resolveRepoSlug(repoRootAbs, detection, config);
  const owner = await resolveOwner(repoRootAbs, detection, config, adapter);
  const driver = createGhDriver({ cwd: repoRootAbs });

  const cleanup = await bestEffortCleanupQueue(repoRootAbs, adapter).catch(() => null);

  return {
    cwd: process.cwd(),
    repoRoot: repoRootAbs,
    adapter,
    legacyAdapterPath: legacyAdapter.ok ? legacyAdapter.path : null,
    legacyAdapterLoadError: legacyAdapter.ok ? null : legacyAdapter.error,
    config,
    configPath: config?.ok ? config.path : configPath(repoRootAbs),
    configValue,
    repoSlug: repoSlug ?? "owner/repo",
    owner,
    driver,
    packageVersion: PACKAGE_VERSION,
    lastTaskId: null,
    cleanupQueueOnStartup: cleanup,
    recover: () => recoverManifestAfterCrash,
  };
}

const factories = {
  inspect: {
    args: { taskId: tool.schema.string().describe("Manifest taskId to inspect.") },
    build: (rt) => createInspectTool({
      driver: rt.driver,
      repoRoot: rt.repoRoot,
      repoSlug: rt.repoSlug,
      owner: rt.owner,
      adapter: rt.adapter,
      packageVersion: rt.packageVersion,
      remote: "origin",
    }),
  },
  issue: {
    args: {
      taskId: tool.schema.string(),
      title: tool.schema.string(),
      body: tool.schema.string().optional(),
      baseBranch: tool.schema.string(),
      baseSha: tool.schema.string().optional(),
      branch: tool.schema.string(),
      labels: tool.schema.array(tool.schema.string()).optional(),
    },
    build: (rt) => createIssueTool({
      driver: rt.driver,
      repoRoot: rt.repoRoot,
      repoSlug: rt.repoSlug,
      owner: rt.owner,
      adapter: rt.adapter,
      remote: "origin",
    }),
  },
  worktree: {
    args: {
      taskId: tool.schema.string(),
      branch: tool.schema.string(),
      worktreeRelativePath: tool.schema.string(),
    },
    build: (rt) => createWorktreeTool({
      driver: rt.driver,
      repoRoot: rt.repoRoot,
      repoSlug: rt.repoSlug,
      owner: rt.owner,
      adapter: rt.adapter,
      remote: "origin",
    }),
  },
  verify: {
    args: {
      taskId: tool.schema.string(),
      commandId: tool.schema.string().optional(),
    },
    build: (rt) => createVerifyTool({
      driver: rt.driver,
      repoRoot: rt.repoRoot,
      repoSlug: rt.repoSlug,
      owner: rt.owner,
      adapter: rt.adapter,
      remote: "origin",
    }),
  },
  review: {
    args: {
      taskId: tool.schema.string(),
      status: tool.schema.enum(["pass", "fail", "blocked", "partial"]),
      headSha: tool.schema.string().optional(),
      findings: tool.schema.unknown().optional(),
      envelope: tool.schema.unknown().optional(),
    },
    build: (rt) => createReviewTool({
      driver: rt.driver,
      repoRoot: rt.repoRoot,
      repoSlug: rt.repoSlug,
      owner: rt.owner,
      adapter: rt.adapter,
      remote: "origin",
    }),
  },
  pr: {
    args: {
      taskId: tool.schema.string(),
      title: tool.schema.string(),
      body: tool.schema.string(),
    },
    build: (rt) => createPrTool({
      driver: rt.driver,
      repoRoot: rt.repoRoot,
      repoSlug: rt.repoSlug,
      owner: rt.owner,
      adapter: rt.adapter,
      remote: "origin",
    }),
  },
  ready: { args: { taskId: tool.schema.string() }, build: (rt) => createReadyTool({
    driver: rt.driver,
    repoRoot: rt.repoRoot,
    repoSlug: rt.repoSlug,
    owner: rt.owner,
    adapter: rt.adapter,
    remote: "origin",
  }) },
  merge: {
    args: { taskId: tool.schema.string(), subject: tool.schema.string() },
    build: (rt) => createMergeTool({
      driver: rt.driver,
      repoRoot: rt.repoRoot,
      repoSlug: rt.repoSlug,
      owner: rt.owner,
      adapter: rt.adapter,
      remote: "origin",
    }),
  },
  cleanup: {
    args: { taskId: tool.schema.string() },
    build: (rt) => createCleanupTool({
      driver: rt.driver,
      repoRoot: rt.repoRoot,
      repoSlug: rt.repoSlug,
      owner: rt.owner,
      adapter: rt.adapter,
      remote: "origin",
    }),
  },
  githubRead: {
    args: {
      resource: tool.schema.enum(["issue", "pr", "checks"]),
      number: tool.schema.number().optional(),
      sha: tool.schema.string().optional(),
      operationId: tool.schema.string().optional(),
    },
    build: (rt) => createGithubReadTool({
      driver: rt.driver,
      repoRoot: rt.repoRoot,
      repoSlug: rt.repoSlug,
      owner: rt.owner,
      operationStore: { readOperation: async () => null },
    }),
  },
  issueComment: {
    args: {
      number: tool.schema.number(),
      body: tool.schema.string(),
      operationId: tool.schema.string().optional(),
    },
    build: (rt) => createIssueCommentTool({
      driver: rt.driver,
      repoRoot: rt.repoRoot,
      repoSlug: rt.repoSlug,
      owner: rt.owner,
    }),
  },
  issueLabels: {
    args: {
      number: tool.schema.number(),
      add: tool.schema.array(tool.schema.string()).optional(),
      remove: tool.schema.array(tool.schema.string()).optional(),
      operationId: tool.schema.string().optional(),
    },
    build: (rt) => createIssueLabelsTool({
      driver: rt.driver,
      repoRoot: rt.repoRoot,
      repoSlug: rt.repoSlug,
      owner: rt.owner,
    }),
  },
  issueLink: {
    args: {
      from: tool.schema.number(),
      to: tool.schema.number(),
      relationship: tool.schema.enum(["blocks", "is-blocked-by", "closes", "is-closed-by", "related"]),
      operationId: tool.schema.string().optional(),
    },
    build: (rt) => createIssueLinkTool({
      driver: rt.driver,
      repoRoot: rt.repoRoot,
      repoSlug: rt.repoSlug,
      owner: rt.owner,
    }),
  },
  issueClose: {
    args: {
      number: tool.schema.number(),
      subject: tool.schema.string(),
      operationId: tool.schema.string().optional(),
    },
    build: (rt) => createIssueCloseTool({
      driver: rt.driver,
      repoRoot: rt.repoRoot,
      repoSlug: rt.repoSlug,
      owner: rt.owner,
    }),
  },
  sync: {
    args: {
      base: tool.schema.string(),
      branch: tool.schema.string(),
      operationId: tool.schema.string().optional(),
    },
    build: (rt) => createSyncTool({
      driver: rt.driver,
      repoRoot: rt.repoRoot,
      repoSlug: rt.repoSlug,
      owner: rt.owner,
    }),
  },
  publish: {
    args: {
      taskId: tool.schema.string(),
      expectedHead: tool.schema.string(),
      operationId: tool.schema.string().optional(),
    },
    build: (rt) => createPublishTool({
      driver: rt.driver,
      repoRoot: rt.repoRoot,
      repoSlug: rt.repoSlug,
      owner: rt.owner,
    }),
  },
  planStart: {
    args: {
      issueNumber: tool.schema.number(),
      operationId: tool.schema.string().optional(),
    },
    build: (rt) => createPlanStartTool({
      repoRoot: rt.repoRoot,
      owner: rt.owner,
      config: rt.configValue,
    }),
  },
  taskStart: {
    args: {
      workflowId: tool.schema.string(),
      taskId: tool.schema.string(),
      briefHash: tool.schema.string(),
      sessionID: tool.schema.string(),
      submittedBy: tool.schema.string(),
      operationId: tool.schema.string().optional(),
    },
    build: (rt) => createTaskStartTool({
      repoRoot: rt.repoRoot,
      owner: rt.owner,
      config: rt.configValue,
    }),
  },
  taskCommit: {
    args: {
      workflowId: tool.schema.string(),
      taskId: tool.schema.string(),
      expectedHead: tool.schema.string(),
      commitSha: tool.schema.string(),
      planHash: tool.schema.string(),
      reviewHash: tool.schema.string(),
      round: tool.schema.number(),
      operationId: tool.schema.string().optional(),
    },
    build: (rt) => createTaskCommitTool({
      repoRoot: rt.repoRoot,
      owner: rt.owner,
      config: rt.configValue,
    }),
  },
  taskComplete: {
    args: {
      workflowId: tool.schema.string(),
      taskId: tool.schema.string(),
      moreTasks: tool.schema.boolean(),
      nextTaskId: tool.schema.string().optional(),
      operationId: tool.schema.string().optional(),
    },
    build: (rt) => createTaskCompleteTool({
      repoRoot: rt.repoRoot,
      owner: rt.owner,
      config: rt.configValue,
    }),
  },
  finalReview: {
    args: {
      workflowId: tool.schema.string(),
      axis: tool.schema.enum(["standards", "spec"]),
      verdict: tool.schema.enum(["pass", "fail", "blocked"]),
      headSha: tool.schema.string(),
      mergeBaseSha: tool.schema.string(),
      packageHash: tool.schema.string(),
      submittedBy: tool.schema.string(),
      findings: tool.schema.array(tool.schema.unknown()).optional(),
      operationId: tool.schema.string().optional(),
    },
    build: (rt) => createFinalReviewTool({
      repoRoot: rt.repoRoot,
      owner: rt.owner,
      config: rt.configValue,
    }),
  },
  skillDiscover: {
    args: {
      query: tool.schema.string(),
      operationId: tool.schema.string().optional(),
    },
    build: (rt) => createSkillDiscoverTool({
      repoRoot: rt.repoRoot,
      owner: rt.owner,
      config: rt.configValue,
    }),
  },
  skillInstall: {
    args: {
      package: tool.schema.string(),
      skillName: tool.schema.string(),
      worktreePath: tool.schema.string(),
      version: tool.schema.string().optional(),
      operationId: tool.schema.string().optional(),
    },
    build: (rt) => createSkillInstallTool({
      repoRoot: rt.repoRoot,
      owner: rt.owner,
      config: rt.configValue,
    }),
  },
  skillAudit: {
    args: {
      operationId: tool.schema.string().optional(),
    },
    build: (rt) => createSkillAuditTool({
      repoRoot: rt.repoRoot,
      owner: rt.owner,
      config: rt.configValue,
    }),
  },
  skillUninstall: {
    args: {
      skill: tool.schema.string(),
      operationId: tool.schema.string().optional(),
    },
    build: (rt) => createSkillUninstallTool({
      repoRoot: rt.repoRoot,
      owner: rt.owner,
      config: rt.configValue,
    }),
  },
  planSubmit: {
    args: {
      workflowId: tool.schema.string(),
      revision: tool.schema.number(),
      plan: tool.schema.unknown(),
      sha256: tool.schema.string().optional(),
      submittedBy: tool.schema.string(),
      operationId: tool.schema.string().optional(),
    },
    build: (rt) => createPlanSubmitTool({
      repoRoot: rt.repoRoot,
      owner: rt.owner,
    }),
  },
  planApprove: {
    args: {
      workflowId: tool.schema.string(),
      revision: tool.schema.number(),
      sha256: tool.schema.string(),
      subject: tool.schema.string(),
      operationId: tool.schema.string().optional(),
    },
    build: (rt) => createPlanApproveTool({
      repoRoot: rt.repoRoot,
      owner: rt.owner,
    }),
  },
  runStart: {
    args: {
      workflowId: tool.schema.string(),
      revision: tool.schema.number().optional(),
      sha256: tool.schema.string().optional(),
      operationId: tool.schema.string().optional(),
    },
    build: (rt) => createRunStartTool({
      repoRoot: rt.repoRoot,
      owner: rt.owner,
      configValue: rt.configValue,
    }),
  },
  taskReport: {
    args: {
      workflowId: tool.schema.string(),
      taskId: tool.schema.string(),
      round: tool.schema.number(),
      submittedBy: tool.schema.string(),
      summary: tool.schema.string(),
      changes: tool.schema.array(tool.schema.unknown()).optional(),
      tests: tool.schema.array(tool.schema.unknown()).optional(),
      operationId: tool.schema.string().optional(),
    },
    build: (rt) => createTaskReportTool({
      repoRoot: rt.repoRoot,
      owner: rt.owner,
      config: rt.configValue,
    }),
  },
  taskReview: {
    args: {
      workflowId: tool.schema.string(),
      taskId: tool.schema.string(),
      round: tool.schema.number(),
      submittedBy: tool.schema.string(),
      spec: tool.schema.object({
        verdict: tool.schema.enum(["pass", "none", "fail"]),
        notes: tool.schema.string().optional(),
      }),
      quality: tool.schema.object({
        verdict: tool.schema.enum(["pass", "none", "fail"]),
        notes: tool.schema.string().optional(),
      }),
      operationId: tool.schema.string().optional(),
    },
    build: (rt) => createTaskReviewTool({
      repoRoot: rt.repoRoot,
      owner: rt.owner,
      config: rt.configValue,
    }),
  },
  resume: {
    args: {
      workflowId: tool.schema.string(),
      operationId: tool.schema.string().optional(),
    },
    build: (rt) => createResumeTool({
      repoRoot: rt.repoRoot,
      owner: rt.owner,
    }),
  },
  status: {
    args: {
      workflowId: tool.schema.string(),
      operationId: tool.schema.string().optional(),
    },
    build: (rt) => createStatusTool({
      repoRoot: rt.repoRoot,
      owner: rt.owner,
    }),
  },
};

export const ShipPlugin = async (ctx) => {
  const worktree = (ctx && ctx.worktree) || process.cwd();
  const runtime = await buildRuntime(worktree);
  const tools = {};
  for (const [id, description, key] of toolDefs) {
    const factory = factories[key];
    tools[id] = makeTool(id, description, factory, runtime);
  }
  return {
    tool: tools,
    "experimental.session.compacting": async (input, output) => {
      const current = Array.isArray(output.context) ? output.context : [];
      output.context = [
        ...current,
        "opencode-ship plugin is loaded; one issue -> one worktree -> one PR -> one merge -> one cleanup.",
      ];
    },
    event: async ({ event }) => {
      if (!event) return;
      if (event.type === "session.created" || event.type === "session.idle") {
        await bestEffortCleanupQueue(runtime.repoRoot, runtime.adapter).catch(() => null);
      }
    },
  };
};

export default ShipPlugin;
