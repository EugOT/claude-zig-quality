# ADR 0003: Darwin fuzz degradation on Zig 0.16

- **Status:** Accepted
- **Date:** 2026-04-24
- **Deciders:** repo owner
- **Tags:** zig, fuzz, darwin, ci, degradation, 0.16

## Context

Native `zig build fuzz` on Darwin with Zig `0.16.0` is an
upstream-known broken path, tracked as
[`ziglang/zig#20986`](https://github.com/ziglang/zig/issues/20986).
The fuzz runner fails to link or segfaults at startup on
`aarch64-macos` and `x86_64-macos` targets with the pinned `0.16.0`
toolchain, regardless of host macOS version.

The plan non-negotiables §0.9 are explicit:

> Native fuzzing on Darwin with Zig `0.16.0` is an upstream-known broken
> path. The green gate on macOS must degrade explicitly with a
> warning, not lie.

The local toolkit's validated behavior in `gitstore-cli` already
encodes this with a `zig_supports_fuzz` guard that the new
`scripts/lib/zig.ts` must port. On Darwin with `0.16.0`, that guard
returns `false`, and the verify-pr gate emits a degraded status rather
than a spurious pass.

## Decision

The quality gate degrades explicitly on Darwin + Zig `0.16.0` instead
of either failing or silently passing:

- `scripts/lib/zig.ts` exposes `zigSupportsFuzz()` which returns `false`
  on `darwin` with Zig `0.16.x` and `true` otherwise.
- `scripts/verify-pr.ts` surfaces `status: "degraded"` for the fuzz
  sub-gate when `zigSupportsFuzz()` is `false`, and prints a one-line
  notice including the upstream issue URL.
- CI on macOS runners follows the same rule: the fuzz job emits a
  degraded notice and exits 0 by default.
- An override is available for operators who want the native behavior
  regardless: `ZIG_QM_FORCE_FUZZ=1` attempts `zig build fuzz` and
  treats its failure as a hard fail. CI workflow code that sets this
  flag must also document the known-failure expectation (flaky job,
  manual re-run, or tag-pinned baseline).

## Consequences

- **Positive:** The gate never lies. Darwin users see `degraded` with
  an issue link; Linux users get full fuzz coverage.
- **Positive:** The degradation path is a single explicit branch that
  can be removed in one commit once upstream resolves `#20986`.
- **Negative:** Fuzz coverage on Darwin is structural-only in the
  default flow; real fuzz runs require a Linux CI runner, a container,
  or the `ZIG_QM_FORCE_FUZZ=1` override.
- **Negative:** A future contributor who reads only the gate output
  without the ADR might mistake `degraded` for `not running`. Mitigated
  by the notice text including this ADR's filename and the upstream
  issue URL.

## Alternatives considered

- **Silently skip fuzz on Darwin.** Rejected. Plan §0.9 forbids this;
  it is the worst failure mode because it looks like a pass.
- **Hard-fail on Darwin.** Rejected. Developers on Apple Silicon would
  be unable to use the template at all, which regresses the primary
  adopter workflow (`gitstore-cli` is developed on Darwin).
- **Cross-compile fuzz to Linux from Darwin.** Rejected for v0.
  Cross-target fuzz runs depend on Linux-side runtime support that
  `zig build fuzz` does not currently expose as a portable knob in
  `0.16.0`. Deferred as a v1 CI lane.
- **Wait for `0.16.x` patch release.** Rejected. The plan requires a
  shippable template today; the degradation is reversible the moment
  upstream ships a fix, by flipping `zigSupportsFuzz()` back to `true`
  on Darwin.

## Validation

- `bun scripts/verify-pr.ts` emits `status: "degraded"` with
  `reason: "darwin-fuzz-upstream"` on Darwin hosts.
- The manifest at `.agent/baseline.json` records the last successful
  Linux fuzz run so the degradation is not an indefinite free pass.
- A Linux CI lane (either Forgejo runner or container-based job)
  exercises the same corpus on every PR to prevent regression of the
  non-Darwin path.
- The `zig-fuzz-target` skill body repeats the degradation rule so
  agents do not accidentally remove the guard while writing new fuzz
  targets.

## Consequence: CI policy for Darwin fuzz jobs

For Forgejo or GitHub-Actions-style macOS runners, one of the two
following policies must hold, enforced in the workflow file:

1. **Skip** — do not register a fuzz job for `macos-*` runners; run
   fuzz exclusively on Linux runners. The verify-pr summary shows
   `fuzz: degraded` for PRs reviewed on Darwin-only developer
   machines.
2. **Force with known-failure expectation** — set
   `ZIG_QM_FORCE_FUZZ=1` on macOS runners, mark the job
   `continue-on-error: true` with an explicit comment pointing to
   `ziglang/zig#20986`, and gate the green light on non-fuzz checks.

Both options are defensible; option 1 is the default for v0 because it
matches the local `gitstore-cli` behavior that is known-good today.

## References

- Plan: `~/.claude/scratch/zig-quality-plan.md` §0.9.
- Upstream: `https://github.com/ziglang/zig/issues/20986`.
- Live adopter: `gitstore-cli`'s `scripts/verify-pr.sh` and its
  `zig_supports_fuzz` guard.
- Skill: `.claude/skills/zig-fuzz-target/SKILL.md` (documents the
  degradation rule for agent consumers).
