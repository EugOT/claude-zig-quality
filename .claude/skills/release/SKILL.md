---
name: release
description: Run the release-tier Zig quality gate. Use only when the
  user explicitly invokes /release or asks to validate a release boundary.
  Wraps scripts/verify-release.ts via Bun.
argument-hint: ""
user-invocable: true
disable-model-invocation: true
allowed-tools: Bash(bun scripts/verify-release.ts:*)
---

# /release — Release Boundary Gate

This skill replaces the `/release` command. It is deliberately
**user-only**: `disable-model-invocation: true` prevents the model from
triggering it autonomously. The release tier is destructive-adjacent and
must stay under direct human control.

## What this skill does

- Runs `bun scripts/verify-release.ts`.
- Reports the full gate result (SBOM, reproducibility, long-fuzz budget,
  signed-tag dry-run, public-API baseline diff, cross-target build).

## What this skill does NOT do

- Does not tag, push, or publish. The session boundary ends at `verify`.
- Does not amend history or mutate `main`.
- Does not run implicitly after `/verify pr` or during a Stop hook.

## Operator flow

1. User explicitly invokes `/release` (or asks the agent to run the
   release gate).
2. This skill runs `scripts/verify-release.ts` only.
3. If green, surface the artifact list and next-step instructions for the
   human to execute tag/push outside the session.
4. If red, report the failing sub-gate; do not retry or escalate tiers.

## Notes

- Darwin Zig 0.16.0 native fuzz remains an explicit skip — the release
  fuzz budget runs on Linux CI, not the local macOS host.
- Secrets (signing keys, registry tokens) are referenced by name in
  workflow files only; the session never sees values.
