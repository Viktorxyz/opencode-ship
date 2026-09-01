# Issue Tracker: GitHub

Issues and pull requests for this repository live in
`Viktorxyz/opencode-ship` on GitHub. The default branch is `main`.

## Canonical Operations

```sh
gh issue list --repo Viktorxyz/opencode-ship --label needs-triage
gh issue view <number> --repo Viktorxyz/opencode-ship
gh pr create --repo Viktorxyz/opencode-ship --base main --draft --title <title> --body <body>
gh pr view <number> --repo Viktorxyz/opencode-ship
gh pr merge <number> --repo Viktorxyz/opencode-ship --squash --delete-branch
```

Ship lifecycle mutations go through the installed typed tools. These commands
document the tracker contract for skills that need read-only issue context or
for maintainers operating outside an agent session.
