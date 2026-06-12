---
name: verify
description: Run the tiered Zig quality gate. Use when the user asks
  to verify, run checks before commit, or validate a PR. Dispatches to
  scripts/verify-{fast,commit,pr,release}.ts via Bun.
argument-hint: "[fast|commit|pr|release]"
user-invocable: true
allowed-tools: Bash(bun scripts/verify-fast.ts:*), Bash(bun scripts/verify-commit.ts:*), Bash(bun scripts/verify-pr.ts:*), Bash(bun scripts/verify-release.ts:*)
---

# /verify — Tiered Zig Quality Gate

This skill replaces the `/verify` command. The harness has no
`.claude/commands/` directory; manual workflow entrypoints live here as
skills so the primary interaction surface stays uniform.

## Tier → script map

| Tier | Script | When to run | Target budget |
|---|---|---|---|
| `fast` | `bun scripts/verify-fast.ts` | per-turn, post-edit, default | < 5 s |
| `commit` | `bun scripts/verify-commit.ts` | before every commit | < 30 s |
| `pr` | `bun scripts/verify-pr.ts` | before opening/updating a PR | < 5 min |
| `release` | `bun scripts/verify-release.ts` | release boundary only (user-invoked) | < 30 min |

## Dispatch

- If the user supplies an argument, match it literally against the four
  tiers above.
- If the argument is empty, ambiguous, or unknown, fall back to `fast` and
  state the fallback explicitly in the reply.
- Never invoke `verify-release.ts` implicitly; the `release` tier belongs
  to the `release` skill and requires explicit user intent.
- Run the selected script with `bun`. Do not inline any TypeScript logic;
  all policy lives inside the script.

## What each tier enforces (semantic summary)

- **fast** — `zig fmt --check`, `zig ast-check`, scoped unit tests on
  touched modules. Green light for the inner loop.
- **commit** — adds broader unit tests, `ziglint`, and the §4 scope-aware
  checks so commits cannot land with trivially fixable drift.
- **pr** — adds cross-target build matrix, full test suite,
  `check-public-api` (read mode), short fuzz smoke, and eval structural
  checks.
- **release** — adds long-fuzz budget, SBOM, signed-tag dry-run, reproducible
  build check. Release-only; the `release` skill owns it.

## Zig toolchain

Scripts resolve Zig through `scripts/lib/zig.ts` (equivalent to the old
`zig-tool.sh`) — they do not trust bare `zig` on PATH. Expect `mise x
zig@0.16.0 -- zig` semantics.

## Output

Scripts emit JSON-line diagnostics to stdout and a human summary to
stderr. Surface the summary back to the user verbatim; do not re-narrate
the stdout stream.

## Failure policy

- Non-zero exit from the selected tier means the gate failed. Do not
  proceed with downstream work (commits, PRs, tags) until the failure is
  addressed.
- Darwin Zig 0.16.0 native fuzz is upstream-broken and degrades to an
  explicit skip with warning — that is not a failure.
