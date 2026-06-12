# Release Checklist — Zig 0.16 Tier 4

Provenance: authored from scratch for this repo. There is no upstream
`exact_zig-release-checklist` shared skill, so this file is not
"harvested from a shared skill". The semantics below are sourced from
the validated local `scripts/verify-release.sh` flow in
`gitstore-cli` (clean rebuild, reproducibility hash, deep fuzz gated
by `zig_supports_fuzz`, SBOM, optional cosign signing). Treat this
checklist as the canonical Tier 4 definition until a shared
release-checklist skill exists upstream.

## Scope

Release-tier (Tier 4) runs before tagging a release. It inherits Tier
3 (per-PR) fully and then adds reproducibility, deep fuzz, SBOM, and
optional artifact signing. The runtime layer in this repo implements
these steps in `scripts/verify-release.ts` and keeps
`scripts/verify-release.sh` as a thin shim.

## Order of operations

Run the steps in order. A later step is invalid if an earlier step
did not pass.

1. **Inherit PR gate.** Run `scripts/verify-pr.sh`
   (or `bun scripts/verify-pr.ts`). Abort the release if it exits
   non-zero.
2. **Clean, non-incremental rebuild.** Remove `.zig-cache` and
   `zig-out`, then build with `--summary all`. Reproducibility and
   signing are meaningless on a dirty cache.
3. **Docs build if exposed.** If `zig build -l` lists a `docs` step,
   run `zig build docs --summary failures`. Missing docs output at
   release time is a release-stopping defect.
4. **Deep fuzz, gated.** If `zig build -l` lists a `fuzz` step and
   the runtime reports `zig_supports_fuzz() == true`:
   - Run `zig build fuzz --summary failures --fuzz=<limit> -j<N>`
     wrapped in a real-time budget (`$FUZZ_BUDGET`, default `2h`;
     tag-day runs use `72h`).
   - Treat exit code 124 from the timeout wrapper as "budget elapsed,
     no crashes" — **not** a failure. Any other non-zero exit is a
     fuzz crash and aborts the release.
   - If `zig_supports_fuzz()` returns false (Darwin + Zig 0.16.0 is
     the current known-broken combination), print the explicit skip
     message from `scripts/lib/zig.ts`. **Degrade explicitly; do not
     lie.** This is the upstream-known broken path from plan §0.9 and
     ADR `0006-darwin-fuzz-degradation.md`.
5. **Reproducibility check.** Hash the build output twice:
   - Compute `H1 = shasum -a 256 zig-out/bin/* | shasum -a 256`.
   - Remove `.zig-cache` and `zig-out`.
   - Rebuild with `--summary all`.
   - Compute `H2` the same way.
   - Fail the release if `H1 != H2`; emit both hashes to stderr so
     the diff is inspectable in the log.
6. **SBOM (CycloneDX).** Prefer the Zig-native emitter:
   `zig run scripts/emit-sbom.zig -- build.zig.zon > sbom.cdx.json`.
   A `syft dir:. -o cyclonedx-json` fallback is acceptable when
   `syft` is present. If neither is available, record the gap in the
   build log; do not ship an unsigned release claiming "SBOM"
   without the file.
7. **Cosign signing (optional).** If `cosign` is installed and the
   release session was user-authorized for signing:
   - For each artifact under `zig-out/bin/*`, run
     `cosign sign-blob --yes <artifact> > <artifact>.sig`.
   - A signing failure is loud but not release-stopping by default —
     record the failure in the build log and decide policy at release
     time.

## Per-step pass/fail criteria

| Step | Pass criterion | Failure action |
|---|---|---|
| Inherit PR gate | `verify-pr` exits 0 | Abort release |
| Clean rebuild | `zig build --summary all` exits 0 after cache wipe | Abort release |
| Docs build | `zig build docs --summary failures` exits 0, or step absent | Abort release if present and failing |
| Deep fuzz | Fuzz exits 0 or timeout-wrapper exit 124 (budget elapsed) | Abort release on other non-zero |
| Fuzz gated off | Explicit `zig_fuzz_skip_message` emitted to stderr | Must not print "OK" — degradation is the message |
| Reproducibility | `H1 == H2` | Abort release; emit both hashes |
| SBOM | `sbom.cdx.json` exists and is non-empty | Abort or downgrade per policy |
| Cosign signing | All artifacts have matching `.sig` files, or cosign is absent | Log; policy decision |

## Environment variables the runtime honors

- `FUZZ_BUDGET_SECONDS` — wallclock budget for the deep fuzz step
  (default `2h`; override to `72h` for tag-day runs).
- `RELEASE_FUZZ_LIMIT` — the `--fuzz=<limit>` value passed through to
  `zig build fuzz` (default `1G`).

## Darwin / Zig 0.16.0 explicit degradation

Native fuzz rebuilding is upstream-broken on Darwin with Zig 0.16.0.
The runtime must therefore:

- Report the skip, not a green check.
- Cite the ADR (`doc/adr/0006-darwin-fuzz-degradation.md`) in the
  build log.
- Not mask the skip with a `|| true` or similar shell trick.

This is the canonical example of the "green gate degrades explicitly,
never lies" rule from plan §0.9.

## Where to put this in the harness

- Runtime: `scripts/verify-release.ts`.
- Shim: `scripts/verify-release.sh` (`exec bun ... verify-release.ts`).
- Manual skill entrypoint: `.claude/skills/release/SKILL.md`.
- CI: `.forgejo/workflows/release.yaml` on tag event only.

If the runtime cannot run a step because a dependency is missing
(`cosign`, `syft`, etc.), the runtime logs the absence explicitly and
continues only when policy allows. It does **not** pretend the step
passed.
