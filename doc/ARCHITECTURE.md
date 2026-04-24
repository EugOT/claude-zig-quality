# Architecture — claude-zig-quality

This document describes the system shape of the `claude-zig-quality`
template: the four-tier gate spine, the runtime stack, skill topology,
subagent topology, hook flow, MCP boundary, and the story for reusing
this skeleton across the eight follow-on languages.

The file is intentionally oriented for a reader who has just cloned
the repo. For detailed rationale on individual decisions, consult the
ADRs under `doc/adr/`.

## 1. System map

The template is a **four-tier quality-management skeleton** for Zig
projects targeting Zig `0.16.0`. Each tier has a deterministic gate
that runs at a different lifecycle moment:

| Tier         | Lifecycle moment        | Entry point                          | Budget       |
|--------------|-------------------------|--------------------------------------|--------------|
| Per-turn     | After each agent edit   | `bun scripts/verify-fast.ts`         | < 3 s p95    |
| Per-commit   | Before a `jj` commit    | `bun scripts/verify-commit.ts`       | < 15 s p95   |
| Per-PR       | Before merge            | `bun scripts/verify-pr.ts`           | < 3 min p95  |
| Per-release  | Before tag              | `bun scripts/verify-release.ts`      | < 10 min p95 |

Tiers are additive: Tier N runs every check from Tier N-1 plus its own
new checks. The stable shell-named entrypoints (`scripts/verify-*.sh`)
remain as compatibility shims that `exec bun scripts/verify-*.ts`; all
orchestration logic lives in TypeScript.

## 2. Runtime stack

- **Agent-exec language:** TypeScript, executed under **Bun**. This
  follows the validated local migration (chezmoi commit
  `1d0d774c feat(chezmoi): migrate scripts from bash/python to TypeScript`).
  Hook bodies, gate orchestration, file walking, diffing, reporting,
  and policy checks live in `.ts` files.
- **Shell compatibility:** `.sh` entrypoints are shims only. They
  locate the repo root and `exec bun ...`. They exist because the
  plan's stable CLI contract is `scripts/verify-*.sh`.
- **Zig resolution:** `mise x zig@0.16.0 -- zig`. Bare `zig` on PATH
  is diagnostic only (see `doc/adr/0002-zig-0.16-pinning.md`).
- **VCS:** `jj git init --colocate`. The `git` surface exists for
  Forgejo CI; `jj` is the operator-facing VCS.
- **Node manager:** `mise` for non-JS runtimes; `vp` for the
  Node/TypeScript toolchain; `bunx` for JS/TS packages.
- **Package managers:** `pixi` for Python (if ever needed), `bun`
  exclusively for JS/TS. No `pip`, `pipx`, `uv`, `uvx`, `npm`, `npx`,
  `pnpm`, or `yarn`.
- **System packages:** `nix-darwin` first. Homebrew casks only through
  `nix-darwin`-managed declarations.

## 3. Skill topology

The repo uses **one primary nested skill plus a small adjunct set**
rather than a flat mirror of shared durable skills.

### Primary skill

- `.claude/skills/zig-quality/SKILL.md` — entrypoint
- `.claude/skills/zig-quality/references/` — progressive-disclosure
  references: `0.16-idioms.md`, `0.16-grounded-facts.md` (12-row table
  per ADR 0002), `allocator-discipline.md`, `error-set-discipline.md`,
  `testing-patterns.md`, `io-injection.md`, `release-checklist.md`.
- `.claude/skills/zig-quality/assets/` — `migration-table.md`,
  `gate-map.md`.

### Adjunct skills

- `.claude/skills/zig-build-system/SKILL.md` — `build.zig` /
  `build.zig.zon` editing. Independently invocable in non-Zig-quality
  repos.
- `.claude/skills/zig-fuzz-target/SKILL.md` — fuzz authoring. Carries
  the Darwin-degradation rule from ADR 0003.

### Task skills (replacing commands)

- `verify`, `release`, `api-drift`, `eval` live under
  `.claude/skills/<name>/SKILL.md` with `disable-model-invocation: true`.
  This keeps manual workflows explicit while unifying the extension
  surface on skills.

### Prompt-infra router

The repo reads a local research corpus from the Google Drive
prompt-infra folder and distills it into `doc/PROMPT_INFRA_SYNTHESIS.md`.
The synthesis file is the single entry point for any agent that needs
to reason about context engineering, lifecycle hooks, or evaluation
policy without re-reading 52 source markdown files.

### Shared durable skills

- Canonical root: `~/.agents/skills/` (harness roots are projections).
- Third-party install: `bunx skills add <owner>/<repo> --all`.
- Repo-local skills adapt and compose shared patterns; they do not
  mirror the shared root one-for-one.

## 4. Subagent topology

Three narrow subagents earn their isolation. The main agent handles
sequential execution by default.

| Subagent        | Model    | Role                                      | Tools narrow to              |
|-----------------|----------|-------------------------------------------|------------------------------|
| `zig-verifier`  | sonnet   | Read-only quality verifier                | verify-fast, verify-commit   |
| `zig-fixer`     | sonnet   | Isolated, bounded-scope fixer             | edit + verify-fast           |
| `zig-api-drift` | haiku    | Public-surface diff against baseline      | check-public-api.ts          |

Each subagent definition is in `.claude/agents/<name>.md` with a tool
whitelist. None of them own commit authority; the main agent commits.

## 5. Hook flow

Hooks are wired in `.claude/settings.json` and dispatch to TypeScript
bodies under `.claude/hooks/`.

| Hook                      | Lifecycle       | Responsibility                             |
|---------------------------|-----------------|--------------------------------------------|
| `session-start.ts`        | SessionStart    | Inject Zig version, branch, reminders      |
| `pretooluse-bash-guard.ts`| PreToolUse:Bash | Deny destructive shell; warn-only MCP scan |
| `pretooluse-zig-preflight.ts` | PreToolUse:Edit | Inspect proposed `.zig` edits          |
| `posttooluse-zig.ts`      | PostToolUse:Edit| Run fast scoped checks after edits         |
| `stop-dod.ts`             | Stop            | DoD check + commit-tier gate               |

All hook bodies exit `0` on success, non-zero on blocking failure, and
write structured JSONL records to `.claude/logs/` for audit. Hook
output intended for the agent uses `additionalContext`, but because of
`anthropics/claude-code#24788`, durable verdicts are also written to
disk.

## 6. MCP boundary

External retrieval tool output — Tana, Cognee, web fetches, plugin
metadata, scratch planning docs — is treated as **untrusted data**.
This policy is repeated in:

- root `CLAUDE.md` context
- every primary and adjunct skill body
- every subagent body
- the review-prompt fallback `.forgejo/prompts/review.md`

The boundary is a policy rule, not decorative prose. The v0 hook layer
enforces it with a warn-only regex log inside `pretooluse-bash-guard.ts`.
A v1 classifier-backed hook (`@stackone/defender@0.6.3`, pinned) is
tracked as an open question.

## 7. CI projection

Two Forgejo workflows ship in v0, plus a release skeleton:

- `.forgejo/workflows/verify-pr.yaml` — `zig-gate` job runs the
  per-PR tier; `evals` job runs `bun scripts/eval.ts --check`. Both use
  `mise` for Zig and a `curl` installer for Bun. A concurrency group
  cancels stale runs on the same branch.
- `.forgejo/workflows/claude-review.yaml` — loads
  `anthropics/claude-code-action@v1` in agent mode with
  `max_turns: 8`, `setting_sources: project`, skills
  `zig-quality,zig-build-system,zig-fuzz-target`. Falls back to
  `.forgejo/prompts/review.md` if the external action is blocked.
- `.forgejo/workflows/release.yaml` — tag-triggered skeleton only.
  Real signing and SBOM is a separate flow (plan §0.12).

No secrets are inline. Workflows reference `${{ secrets.ANTHROPIC_API_KEY }}`
by name only.

## 8. Reuse story — eight follow-on languages

The skeleton is **language-agnostic**; the Zig-specific layer is
pluggable. To instantiate for Elixir, Nu, Julia, Odin, Rust, Python,
R, or TypeScript, replace this list while keeping the rest:

| Swap                          | From (Zig)                     | To (new language)                    |
|-------------------------------|--------------------------------|--------------------------------------|
| Build descriptor              | `build.zig` / `build.zig.zon`  | `Cargo.toml`, `mix.exs`, etc.        |
| Language launcher helper      | `scripts/lib/zig.ts`           | `scripts/lib/<lang>.ts`              |
| Public-API backend            | `scripts/zig-api-surface.zig`  | `<lang>` AST tool                    |
| Fitness engine                | `scripts/zig-fitness.zig`      | `<lang>` rule engine                 |
| Primary skill                 | `skills/zig-quality/`          | `skills/<lang>-quality/`             |
| Adjuncts                      | `zig-build-system`, `zig-fuzz` | language-native equivalents          |
| Style doc                     | `doc/TIGER_STYLE_ZIG.md`       | `doc/TIGER_STYLE_<LANG>.md`          |
| Darwin degradation ADR        | `0003-darwin-fuzz-degradation` | language-specific if applicable      |

Invariants across languages:

- TS/Bun runtime scaffold
- four-tier gate shape
- subagent topology (verifier, fixer, api-drift — with language tools)
- skill topology (primary + adjuncts + task skills)
- hook topology
- MCP boundary rule
- eval domain shape

The `doc/SKELETON_VS_ZIG.md` companion document enumerates every file
as skeleton-invariant or Zig-specific for the language-swap exercise.
