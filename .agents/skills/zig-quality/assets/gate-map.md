# Four-Tier Gate Map

One-page visual of the quality-management gate topology for this
repo. Use it when reasoning about where a new check belongs or why a
failing check is showing up at the wrong tier.

## Topology

```
     per-turn              per-commit            per-PR               per-release
     (seconds)             (minutes)             (minutes)            (hours)
  +-------------+       +--------------+      +-------------+      +------------------+
  |   Tier 1    |  -->  |    Tier 2    | -->  |   Tier 3    | -->  |     Tier 4       |
  | verify-fast |       | verify-commit|      | verify-pr   |      | verify-release   |
  +-------------+       +--------------+      +-------------+      +------------------+
        |                     |                    |                       |
        | edits               | commit             | PR                    | tag
        v                     v                    v                       v
  fmt + ast-check         + unit tests         + cross-target         + clean rebuild
  banned-API scan         + API surface          safety-mode matrix     + reproducibility
  (lightweight)             baseline check      + docs build             + deep fuzz (gated)
                                                + bounded fuzz           + SBOM
                                                  (if supported)         + cosign (optional)
```

## Invocation surface

| Tier | Runtime entrypoint | Shim | Skill / hook that fires it |
|---|---|---|---|
| 1 | `scripts/verify-fast.ts` | `scripts/verify-fast.sh` | `PostToolUse(Write|Edit|MultiEdit)` → `.claude/hooks/posttooluse-zig.ts` (scoped); also `.claude/skills/verify/SKILL.md` for manual runs |
| 2 | `scripts/verify-commit.ts` | `scripts/verify-commit.sh` | `Stop` → `.claude/hooks/stop-dod.ts`; `.claude/skills/verify/SKILL.md` |
| 3 | `scripts/verify-pr.ts` | `scripts/verify-pr.sh` | `.forgejo/workflows/verify-pr.yaml`; `.claude/skills/verify/SKILL.md` |
| 4 | `scripts/verify-release.ts` | `scripts/verify-release.sh` | `.forgejo/workflows/release.yaml` (tag event); `.claude/skills/release/SKILL.md` |

## What runs at each tier

### Tier 1 — per-turn

- `zig fmt --check`
- `zig ast-check`
- optional `ziglint`
- lightweight banned-API grep (see `../references/0.16-idioms.md`)
- empty tree is allowed: "no Zig files to check"

### Tier 2 — per-commit

- all of Tier 1
- `zig build test --summary failures --test-timeout 30s`
- API surface check against `.zig-qm/public-api.txt` if `src/lib.zig`
  exists

### Tier 3 — per-PR

- all of Tier 2
- cross-target build matrix: `x86_64-linux-musl`,
  `aarch64-linux-gnu`, `aarch64-macos`, `x86_64-windows-msvc`,
  `wasm32-wasi`
- safety-mode rotation: `Debug`, `ReleaseSafe`, `ReleaseFast`,
  `ReleaseSmall`
- docs build if exposed
- API drift check / baseline compare
- bounded fuzz **only if** `zig_supports_fuzz()` returns true;
  otherwise print the explicit Darwin/Zig 0.16.0 degradation message

### Tier 4 — per-release

- all of Tier 3
- clean, non-incremental rebuild (cache wiped)
- reproducibility hash comparison (build twice, compare `shasum`)
- deep fuzz, gated by `zig_supports_fuzz`, wrapped in a wall-clock
  budget (exit 124 = budget elapsed, not a failure)
- SBOM emission (prefer `emit-sbom.zig`, syft fallback)
- cosign signing when configured and user-authorized
- full detail: `../references/release-checklist.md`

## Hook surface (TS / Bun runtime)

```
.claude/hooks/
├── session-start.ts              # injects Zig version, branch, local reminders
├── pretooluse-bash-guard.ts      # denies destructive shell; warn-only MCP-tool-name scan
├── pretooluse-zig-preflight.ts   # checks .zig edits before write lands (Tier 0)
├── posttooluse-zig.ts            # runs fast scoped checks after edits (Tier 1)
└── stop-dod.ts                   # Stop-time DoD check; calls commit-tier gate (Tier 2)
```

## Placement rule

A new check belongs at the lowest tier at which it can run in the
tier's time budget without false positives. Cheap syntactic or
grep-level checks go to Tier 1. Anything that needs a compiled test
binary goes to Tier 2. Cross-target and safety-mode matrices are Tier
3. Anything wall-clock-expensive or requiring artifact signing is
Tier 4.

If a check appears at the wrong tier, the failure mode is usually
either a slow CI or a silent miss — hoist it up or push it down until
the tier budget matches the work.
