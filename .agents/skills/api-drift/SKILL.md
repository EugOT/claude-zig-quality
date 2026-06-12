---
name: api-drift
description: Check or rewrite the Zig public-API baseline. Use when the
  user asks about API drift, public surface changes, or wants to accept a
  new baseline. Wraps scripts/check-public-api.ts via Bun.
argument-hint: "[check|--write]"
user-invocable: true
allowed-tools: Bash(bun scripts/check-public-api.ts:*)
---

# /api-drift — Public Surface Baseline

This skill replaces the `/api-drift` command. It orchestrates
`scripts/check-public-api.ts`, which walks the Zig public surface via
`scripts/zig-api-surface.zig` (`std.zig.Ast` emitter) and compares against
`.zig-qm/public-api.txt`.

## Modes

| Mode | Command | Effect |
|---|---|---|
| check (default) | `bun scripts/check-public-api.ts` | Diff current surface against baseline; non-zero exit on drift |
| write | `bun scripts/check-public-api.ts --write` | Regenerate the baseline from current surface |

Without an argument, run the check (read-only) mode.

## When to run

- After any change touching `pub` declarations.
- As part of the `pr` tier (already wired into `verify-pr.ts`).
- Before release, to confirm the baseline matches the tagged commit.

## When to use `--write`

- The drift is intentional and reviewed.
- The new public surface has been signed off in the PR.
- The baseline update lands in the same commit as the code change, with
  WHY/WHAT/IMPACT/VALIDATION in the commit message.

## Output

- `check` — unified diff-style report of additions, removals, and renames.
  Exit code 1 on any drift.
- `--write` — summary of lines rewritten to `.zig-qm/public-api.txt`. No
  diff; run `jj diff` / `git diff` to review before committing.

## Anti-patterns

- Running `--write` to silence unrelated CI failures.
- Committing a regenerated baseline without the code change that caused it.
- Hand-editing `.zig-qm/public-api.txt`; always regenerate with `--write`.
