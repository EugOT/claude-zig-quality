# ADR 0007: Platform coverage and security workflow

- **Status:** Accepted
- **Date:** 2026-06-27
- **Deciders:** repo owner
- **Tags:** macos, orbstack, linux, coverage, security, ci, zig

## Context

The template is developed on macOS, but two important classes of evidence are
Linux-owned:

- Zig `0.16.0` native fuzz on Darwin is intentionally degraded by ADR 0003.
- Coverage and security checks need repeatable Linux execution before the CI
  result can be treated as merge evidence.

The existing four-tier gate already has the right internal shape:

- `scripts/verify-pr.ts` runs cross-target builds, safety modes, docs, ZLS,
  doc coverage, and bounded fuzz when the platform supports it.
- `scripts/verify-release.ts` adds reproducibility, deep fuzz, SBOM, and
  cosign verification when configured.
- `.forgejo/workflows/verify-pr.yaml` runs the PR gate on Linux.

The missing contract was where each platform's result is authoritative.

## Decision

The reusable workflow has three lanes.

| Lane | Purpose | Authority |
|---|---|---|
| macOS native | Fast local development and Darwin-specific regression checks | Not authoritative for fuzz or Linux coverage |
| OrbStack Linux | Local Linux evidence before opening or updating a PR | Authoritative local lane for fuzz and coverage |
| CI Linux | Merge evidence | Authoritative for PR coverage, security, and release signing/SBOM policy |

Implementation artifacts:

- `scripts/lib/platform.ts` classifies the current lane and records whether it
  can authoritatively satisfy fuzz, coverage, and security checks.
- `scripts/orbstack-linux.ts` wraps the `orb` CLI without hard-coding a host
  path into the template. The default local coverage image is Arch Linux
  (`arch:current`) because the live arm64 probe installs `kcov 43` from the
  regular package repository.
- `scripts/coverage-linux.ts` runs `kcov` only on Linux by default and emits a
  machine-readable result to `coverage/summary.json`.
- `scripts/coverage-docker.ts` builds and runs the repo-owned Fedora/kcov
  image so CI and local Docker/OrbStack can collect measured coverage without
  depending on the host Ubuntu package index.
- `scripts/security-scan.ts` runs repo-local security checks and optional
  scanners when installed.
- `.forgejo/workflows/coverage-security.yaml` projects the same checks into CI.

## Policy

macOS native green means:

- `verify-fast`, `verify-commit`, and as much of `verify-pr` as the host can
  execute passed.
- Darwin fuzz degradation was explicitly printed if the `fuzz` step exists.

macOS native green does **not** mean:

- Linux fuzz ran.
- kcov coverage was measured.
- CI workflow/security scanning passed.

OrbStack Linux green means:

- The local Linux VM/container ran the PR gate.
- Linux fuzz ran when the project exposes a `fuzz` step.
- Coverage met the configured threshold. Advisory/bootstrap runs may explicitly
  use `--skip-missing-kcov`, but they are not coverage evidence.

Current Zig `0.16.0` caveat:

- The live `arch:current` and `ubuntu:noble` arm64 OrbStack PR-gate probes both
  fail at bounded fuzz in Zig's compiler test runner:
  `expected type '*const debug.StackTrace', found '*builtin.StackTrace'`.
- This is a toolchain fuzz blocker, not an OrbStack or coverage failure.
- Until the pinned Zig toolchain fixes it, collect local coverage/security
  evidence separately from `verify-pr` when fuzz is the only failing Linux
  phase.

CI Linux green means:

- The merge-authoritative PR gate passed.
- Security checks passed.
- Coverage met the enforced threshold and wrote `coverage/summary.json`.

## Consequences

- **Positive:** Darwin degradation remains honest while developers still get a
  local Linux path before PR.
- **Positive:** CI is no longer the first place Linux-only fuzz and coverage
  failures appear.
- **Positive:** Missing tools (`orb`, `kcov`, `zizmor`, `gitleaks`) are explicit
  states, not false successes.
- **Negative:** The first coverage baseline must run in a Docker/Fedora or
  package-provisioned Linux lane. In live `ubuntu:24.04` arm64 and amd64
  probes, default apt did not provide a `kcov` package.
- **Positive:** The live `arch:current` arm64 OrbStack probe installed
  package-managed `kcov 43` and produced source coverage without building kcov
  from source.
- **Negative:** OrbStack machine provisioning is host-local and cannot be
  assumed in CI.

## Validation

- `bun test tests/unit/platform.test.ts`
- `bun test tests/unit/orbstack-linux.test.ts`
- `bun test tests/unit/coverage-linux.test.ts`
- `bun test tests/unit/coverage-docker.test.ts`
- `bun test tests/unit/security-scan.test.ts`
- `bun test tests/unit/coverage-security-yaml.test.ts`
- `bun scripts/security-scan.ts`
- On Linux or OrbStack: `bun scripts/coverage-linux.ts --fail-under-lines 95`
- On OrbStack Arch: `bun scripts/coverage-linux.ts --fail-under-lines 90`
  produced `98.14%` line coverage over `src/*.zig` test binaries.
- On Docker/OrbStack: `bun scripts/coverage-docker.ts --fail-under-lines 95`
  builds the pinned Fedora/kcov image and requires a measured summary.
- On OrbStack Arch: `bun scripts/verify-pr.ts` still fails at bounded fuzz with
  the Zig `0.16.0` StackTrace mismatch described above.
- On macOS: `bun scripts/coverage-linux.ts` must skip with `reason=non-linux`

## References

- ADR 0003: Darwin fuzz degradation on Zig 0.16.
- ADR 0005: Reproducible-build verification on Darwin.
- `.claude/skills/zig-quality/references/platform-coverage-security.md`.
