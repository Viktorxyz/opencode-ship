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

export function nextLine(stage) {
  switch (stage) {
    case "setup": return "Next: tell me what you want to build.";
    case "discover": return "Next: I will use these skills while building.";
    case "plan": return "Next: say if this is the product you want.";
    case "approve": return "Next: start building now, or continue later.";
    case "track": return "Next: building starts.";
    case "build":
    case "review":
    case "verify": return "Next: I keep going.";
    case "ready": return "Next: say if I should merge it.";
    case "merge": return "Next: cleanup.";
    case "cleanup": return "Next: tell me what to build next.";
    default: return null;
  }
}
