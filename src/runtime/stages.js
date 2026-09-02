export const STAGES = [
  "setup", "discover", "shape", "plan", "approve",
  "track", "build", "review", "verify", "ready", "merge", "cleanup",
];

export function progressLine(stage, extra = {}) {
  switch (stage) {
    case "setup": return "Setup: ready.";
    case "discover":
      return extra.count > 0
        ? `Discover: ${extra.count} skills installed.`
        : "Discover: none (catalog only).";
    case "plan": return `Plan: ${extra.path}`;
    case "track": return `Track: issue #${extra.number}.`;
    case "build": return `Build: task ${extra.k}/${extra.n} ${extra.title}.`;
    case "review": return extra.ok ? "Review: pass." : "Review: fail (see notes).";
    case "verify": return extra.ok ? "Verify: pass." : "Verify: fail.";
    case "ready": return `Ready: PR #${extra.number}.`;
    case "merge": return `Merge: ${extra.sha}.`;
    case "cleanup": return "Cleanup: done.";
    default: return null; // shape + approve: no line
  }
}
