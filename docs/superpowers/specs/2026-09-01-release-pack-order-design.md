# Release Pack Ordering Design

## Context

The immutable `1.1.6` tag triggered release workflow run `33495352417`.
`source-verify` passed, but the `pack` job failed before publishing. The job
ran `npm ci`, then checked out the release ref again. The second checkout's
clean operation removed `node_modules`, so the fail-closed prepack correctly
reported that `esbuild` was missing.

No npm package or GitHub Release was published for `1.1.6`. The tag remains
immutable and will not be deleted, moved, or reused. The correction therefore
ships as `1.1.7`.

## Design

Keep the release-ref validation and final checkout unchanged. Move the pack
job's dependency installation step to immediately after the final release-ref
checkout. The resulting order is:

1. Resolve and validate the immutable release ref.
2. Check out that ref with the normal clean behavior.
3. Install the lockfile-pinned development dependencies.
4. Run `npm pack`, whose prepack remains fail-closed.

This preserves clean-checkout semantics and avoids `clean: false`, which could
allow stale files from the initial checkout to affect a release artifact.

## Version And Documentation

Advance package and lock metadata to `1.1.7`. Record that `1.1.6` failed in
qualification before publish, while `1.1.7` is the unpublished correction.
Do not claim that `1.1.7` is shipped until npm provenance, qualification
artifacts, and the GitHub Release agree.

## Testing

Add a static release-workflow regression asserting that the final release-ref
checkout occurs before dependency installation and that dependency
installation occurs before `npm pack`. Existing prepack tests continue to
prove that missing build tools fail closed instead of installing implicitly.

Run focused release metadata tests, then canonical `npm run verify`. The PR
must pass Standards review, Spec review, independent verification, required
CI, and the same-HEAD Ready gate before an explicit merge decision.

## Release Acceptance

After merge, create a new immutable `1.1.7` tag on the merged `main` commit.
The release is accepted only when the qualification workflow is green, npm
publishes `opencode-ship@1.1.7` with provenance, the GitHub Release contains
matching tarball and qualification evidence, and the verified version is then
promoted from `next` to `latest`.
