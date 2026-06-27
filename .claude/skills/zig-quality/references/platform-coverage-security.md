# Platform coverage and security workflow

This reference defines where to run each part of the quality workflow. It is
the operator-facing companion to ADR 0007.

## Lane contract

| Lane | Runs | Does not claim |
|---|---|---|
| macOS native | `verify-fast`, `verify-commit`, `verify-pr` structural checks, cross-target builds, docs, ZLS/doc coverage | Linux fuzz, kcov coverage, CI security |
| OrbStack Linux | `verify-pr`, Linux fuzz, kcov coverage, security smoke checks | CI merge authority |
| CI Linux | PR gate, coverage threshold, security scan, evals | Local host readiness |

## Commands

macOS native:

```sh
bun scripts/verify-commit.ts
bun scripts/verify-pr.ts
```

OrbStack Linux:

```sh
bun scripts/orbstack-linux.ts --dry-run
bun scripts/orbstack-linux.ts --create
```

The default OrbStack local coverage lane uses `arch:current` (`zig-qm-arch`).
Provision it with `templates/orbstack/arch-kcov-bootstrap.bash` when a clean
machine needs Bun, mise, Zig `0.16.0`, and package-managed `kcov`. Keep
`ubuntu:noble` as an advisory fallback unless its image installs kcov from a
trusted package or source-build recipe.

Linux coverage:

```sh
bun scripts/coverage-linux.ts --fail-under-lines 95
bun scripts/coverage-docker.ts --fail-under-lines 95
```

Security:

```sh
bun scripts/security-scan.ts
```

## Rules

- Darwin fuzz degradation is an explicit skip, not a pass.
- Coverage thresholds are enforced only on Linux lanes.
- Missing `kcov` is allowed only in advisory/bootstrap mode
  (`--skip-missing-kcov`); enforced CI must install it and omit that flag.
  Ubuntu noble arm64 may not provide `kcov` from default apt repos, so treat
  that as a provisioning blocker, not as coverage evidence.
- The repo-owned Docker lane (`scripts/coverage-docker.ts`) is the preferred
  fail-closed coverage path when the CI host image lacks `kcov`.
- Arch Linux ARM publishes `kcov` through pacman in the tested OrbStack lane.
  Prefer that path locally before carrying a source-build recipe in a template.
- A green Arch coverage run is not the same as a green Linux PR gate. The live
  Zig `0.16.0` arm64 OrbStack probes still fail bounded fuzz in
  `compiler/test_runner.zig` with a `debug.StackTrace` versus
  `builtin.StackTrace` type mismatch. Treat that as a pinned-toolchain blocker.
- Optional scanners such as `zizmor` and `gitleaks` are additive. Their absence
  is reported as skipped rather than hidden.
- Security tooling must not print secrets. Use redaction flags where a scanner
  supports them.
- CI Linux is the merge authority. OrbStack Linux is the local pre-PR authority.

## Adoption checklist

1. Ensure the project exposes `zig build fuzz` and `zig build docs` where
   applicable.
2. Run `bun scripts/orbstack-linux.ts --dry-run` and inspect the command.
3. Provision the OrbStack machine with the same Bun/mise/Zig setup used by CI.
4. Run the OrbStack lane before opening a PR.
5. Add `.forgejo/workflows/coverage-security.yaml` or copy the template under
   `templates/forgejo/coverage-security.yaml`.
6. Use Docker or a package-provisioned Linux lane for enforced coverage; reserve
   `--skip-missing-kcov` for bootstrap diagnostics only.
