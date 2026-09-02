/**
 * Production GitHub driver backed by the GitHub CLI.
 *
 * Every command is `spawn(gh, argv)` with `shell:false`. There is no
 * `gh api *` shortcut used here on purpose: a `gh api` permission ask
 * rule would let the agent bypass the driver's merge-gate checks. By
 * using only typed CLI verbs we keep the surface narrow and auditable.
 *
 * The driver accepts an optional `runner` so unit tests can stub the
 * `gh` invocation without spawning real processes. When the runner is
 * omitted, the driver spawns the `gh` CLI directly. The `cwd` and
 * `env` injection is what keeps the production driver safe to call
 * from any context (worktree, plugin shim, or test).
 */

import { spawn } from "node:child_process";
import { parseRepoSlug } from "./github.js";
import { validateGhArgv } from "./github-command-policy.js";

/**
 * Typed surface of the production GitHub driver. Exposed here so
 * downstream modules can JSDoc-import the driver shape without
 * circular imports.
 *
 * @typedef {{
 *   ensureIssue: (input: { repo: string; title: string; body: string; labels?: string[] }) => Promise<any>,
 *   openDraftPullRequest: (input: { repo: string; head: string; base: string; title: string; body: string; issueNumber: number }) => Promise<any>,
 *   updatePullRequestBody: (input: { repo: string; number: number; body: string }) => Promise<any>,
 *   markReady: (input: { repo: string; number: number }) => Promise<any>,
 *   mergePullRequest: (input: { repo: string; number: number; subject: string }) => Promise<any>,
 *   readPullRequest: (input: { repo: string; number: number }) => Promise<any>,
 *   readChecks: (input: { repo: string; sha?: string; number?: number; branch?: string; required?: string[] }) => Promise<any[]>,
 *   comment: (input: { repo: string; number: number; body: string }) => Promise<any>,
 *   refreshHead: (input: { repo: string; number: number }) => Promise<any>,
 * }} GhDriver
 */

function defaultRunner(cwd, env) {
  return (args) =>
    new Promise((resolve, reject) => {
      const proc = spawn("gh", args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d) => (stdout += d.toString()));
      proc.stderr.on("data", (d) => (stderr += d.toString()));
      proc.on("error", reject);
      proc.on("close", (status) => resolve({ status: status ?? -1, stdout, stderr }));
    });
}

function viewFields() {
  // `gh pr view --json` rejects unknown field names on some `gh`
  // versions (notably `merged`), causing every pr view to fail with
  // "Could not resolve to a node with the global id of 'merged'".
  // We rely on `state` (`OPEN`/`CLOSED`/`MERGED`) and `mergedAt`
  // instead — both are stable fields available across `gh` 2.x.
  return [
    "number",
    "url",
    "baseRefName",
    "headRefName",
    "headRefOid",
    "isDraft",
    "mergeable",
    "mergeStateStatus",
    "state",
    "mergedAt",
  ].join(",");
}

function pullRequestSummaryFromView(fields) {
  const merged =
    fields.state === "MERGED" ||
    fields.merged === true ||
    (typeof fields.mergedAt === "string" && fields.mergedAt.length > 0);
  return {
    number: fields.number,
    url: fields.url,
    baseRefName: fields.baseRefName,
    headRefName: fields.headRefName,
    headSha: fields.headRefOid,
    draft: Boolean(fields.isDraft),
    mergeable: fields.mergeable ?? "UNKNOWN",
    mergeStateStatus: fields.mergeStateStatus ?? "UNKNOWN",
    state: fields.state ?? "UNKNOWN",
    merged: Boolean(merged),
    mergedAt: fields.mergedAt ?? null,
  };
}

async function ghJson(run, args) {
  const r = await run(args);
  if (r.status !== 0) {
    throw new Error(`gh ${args.join(" ")} failed: ${r.stderr.trim() || "(no stderr)"}`);
  }
  if (!r.stdout.trim()) {
    throw new Error(`gh ${args.join(" ")} returned empty stdout`);
  }
  return JSON.parse(r.stdout);
}

export function createGhDriver(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const run = opts.runner ?? defaultRunner(cwd, env);

  return {
    async ensureIssue({ repo, title, body, labels }) {
      const repoSlug = parseRepoSlug(repo);
      if (!repoSlug) throw new Error(`ensureIssue: invalid repo slug ${repo}`);

      const list = await run([
        "issue",
        "list",
        "--repo",
        repo,
        "--search",
        title,
        "--state",
        "open",
        "--json",
        "number,title,state,url",
        "--limit",
        "20",
      ]);
      if (list.status === 0 && list.stdout.trim()) {
        const issues = JSON.parse(list.stdout);
        const exact = issues.find(
          (i) => i.title?.trim() === title.trim() && i.state === "OPEN",
        );
        if (exact) {
          return {
            summary: {
              number: exact.number,
              url: exact.url,
              state: "OPEN",
              pullRequest: null,
            },
            created: false,
          };
        }
      }

      const createArgs = ["issue", "create", "--repo", repo, "--title", title, "--body", body];
      for (const label of labels ?? []) {
        createArgs.push("--label", label);
      }
      const created = await run(createArgs);
      if (created.status !== 0) {
        throw new Error(`gh issue create failed: ${created.stderr.trim() || "(no stderr)"}`);
      }
      const url = (created.stdout.trim().split("\n").pop() ?? "").trim();
      const m = url.match(/\/issues\/(\d+)/);
      const number = m && m[1] ? parseInt(m[1], 10) : -1;
      return {
        summary: { number, url, state: "OPEN", pullRequest: null },
        created: true,
      };
    },

    async openDraftPullRequest({ repo, head, base, title, body, issueNumber }) {
      if (!parseRepoSlug(repo)) throw new Error(`openDraftPullRequest: invalid repo slug ${repo}`);
      if (typeof issueNumber !== "number") throw new Error("openDraftPullRequest: issueNumber is required");
      const issueBody = body.includes(`Closes #${issueNumber}`)
        ? body
        : `${body}\n\nCloses #${issueNumber}`;
      const args = [
        "pr",
        "create",
        "--repo",
        repo,
        "--draft",
        "--base",
        base,
        "--head",
        head,
        "--title",
        title,
        "--body",
        issueBody,
      ];
      const r = await run(args);
      if (r.status !== 0) {
        throw new Error(`gh pr create failed: ${r.stderr.trim() || "(no stderr)"}`);
      }
      const url = (r.stdout.trim().split("\n").pop() ?? "").trim();
      const m = url.match(/\/pull\/(\d+)/);
      const number = m && m[1] ? parseInt(m[1], 10) : -1;
      const fields = await ghJson(run, [
        "pr",
        "view",
        String(number),
        "--repo",
        repo,
        "--json",
        viewFields(),
      ]);
      return pullRequestSummaryFromView(fields);
    },

    async updatePullRequestBody({ repo, number, body }) {
      if (typeof number !== "number") throw new Error("updatePullRequestBody: number is required");
      const r = await run(["pr", "edit", String(number), "--repo", repo, "--body", body]);
      if (r.status !== 0) throw new Error(`gh pr edit failed: ${r.stderr.trim() || "(no stderr)"}`);
    },

    async markReady({ repo, number }) {
      if (typeof number !== "number") throw new Error("markReady: number is required");
      const r = await run(["pr", "ready", String(number), "--repo", repo]);
      if (r.status !== 0) throw new Error(`gh pr ready failed: ${r.stderr.trim() || "(no stderr)"}`);
    },

    async mergePullRequest({ repo, number, subject }) {
      if (typeof number !== "number") throw new Error("mergePullRequest: number is required");
      const args = [
        "pr",
        "merge",
        String(number),
        "--repo",
       repo,
        "--squash",
        "--subject",
        subject,
      ];
      const r = await run(args);
      if (r.status !== 0) {
        throw new Error(`gh pr merge failed: ${r.stderr.trim() || "(no stderr)"}`);
      }
      const fields = await ghJson(run, [
        "pr",
        "view",
        String(number),
        "--repo",
        repo,
        "--json",
        viewFields(),
      ]);
      return pullRequestSummaryFromView(fields);
    },

    async readPullRequest({ repo, number }) {
      if (typeof number !== "number") throw new Error("readPullRequest: number is required");
      const fields = await ghJson(run, [
        "pr",
        "view",
        String(number),
        "--repo",
        repo,
        "--json",
        viewFields(),
      ]);
      return pullRequestSummaryFromView(fields);
    },

    async readChecks({ repo, sha, number, branch, required }) {
      // `gh pr checks` accepts a PR identity (number, URL, or branch),
      // not a commit SHA. Prefer the explicit PR identity when given;
      // fall back to the SHA only when no PR identity is provided.
      const target =
        typeof number === "number" && Number.isFinite(number)
          ? String(number)
          : typeof branch === "string" && branch.length > 0
            ? branch
            : typeof sha === "string" && sha.length > 0
              ? String(sha)
              : null;
      if (target === null) {
        throw new Error("readChecks requires either a number, branch, or sha");
      }
      const r = await run([
        "pr",
        "checks",
        target,
        "--repo",
        repo,
        "--json",
        "name,state,bucket",
      ]);
      if (r.status !== 0) {
        if (/no checks reported/i.test(r.stderr ?? "")) {
          return [];
        }
        throw new Error(`gh pr checks failed: ${r.stderr.trim() || "(no stderr)"}`);
      }
      const all = r.stdout.trim() ? JSON.parse(r.stdout) : [];
      const out = [];
      for (const requiredName of required ?? []) {
        const match = all.find((c) => c.name === requiredName);
        if (!match) {
          out.push({ name: requiredName, state: "pending", bucket: "pending" });
          continue;
        }
        out.push({ name: match.name, state: match.state, bucket: match.bucket });
      }
      return out;
    },

    async comment({ repo, number, body }) {
      if (typeof number !== "number") throw new Error("comment: number is required");
      const r = await run(["issue", "comment", String(number), "--repo", repo, "--body", body]);
      if (r.status !== 0) throw new Error(`gh issue comment failed: ${r.stderr.trim() || "(no stderr)"}`);
    },

    async refreshHead({ repo, number }) {
      if (typeof number !== "number") throw new Error("refreshHead: number is required");
      const fields = await ghJson(run, [
        "pr",
        "view",
        String(number),
        "--repo",
        repo,
        "--json",
        "headRefOid",
      ]);
      return fields.headRefOid;
    },

    async readIssue({ repo, number }) {
      if (typeof number !== "number") throw new Error("readIssue: number is required");
      if (!parseRepoSlug(repo)) throw new Error(`readIssue: invalid repo slug ${repo}`);
      return ghJson(run, [
        "issue",
        "view",
        String(number),
        "--repo",
        repo,
        "--json",
        "title,body",
      ]);
    },

    async runCommand(argv) {
      // Production gh command gateway. Every command must pass the
      // argv allowlist policy; the runner is the same spawn helper
      // used by the typed methods, so credential and cwd handling
      // stay consistent. The argv must be a normalised array, not a
      // string, so shell injection is structurally impossible.
      if (!Array.isArray(argv) || argv.length === 0) {
        throw new Error("runCommand: argv must be a non-empty array");
      }
      if (typeof argv[0] !== "string" || argv[0].length === 0) {
        throw new Error("runCommand: argv[0] must be a non-empty string");
      }
      const policy = validateGhArgv(argv);
      if (!policy.ok) {
        throw new Error(`runCommand: rejected by policy: ${policy.reason}`);
      }
      const r = await run(argv);
      return r;
    },
  };
}

/**
 * Build a deterministic in-memory driver for unit tests. The runner
 * is keyed by a sentinel string encoded into the command's first arg
 * so each test can stub a specific `gh` verb without leaking state.
 */
export function createGhStub(responses) {
  const queue = responses.map((r) => ({ ...r }));
  const runner = async (args) => {
    const head = args[0] ?? "";
    const idx = queue.findIndex((entry) => entry.match(args));
    if (idx === -1) {
      return {
        status: 1,
        stdout: "",
        stderr: `gh stub: no response queued for ${head}`,
      };
    }
    const next = queue[idx];
    queue.splice(idx, 1);
    return { status: next.status ?? 0, stdout: next.stdout ?? "", stderr: next.stderr ?? "" };
  };
  return { driver: createGhDriver({ runner }), queue };
}
