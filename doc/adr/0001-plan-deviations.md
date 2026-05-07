# ADR 0001: Plan deviations

- **Status:** Accepted
- **Date:** 2026-04-24
- **Deciders:** repo owner
- **Tags:** runtime, bun, ci, acceptance-criteria

## Context

The execution plan `~/.claude/scratch/zig-quality-plan.md` (Group C,
step 1) specified this acceptance criterion for Gate C:

> "`bun.lock` exists" after `bun install` runs against an empty
> dependency list.

Live observation during Group C execution contradicts this. Bun
`1.3.3` ran `bun install` successfully in the repo root with an empty
`dependencies` / `devDependencies` set. Instead of creating a
zero-entry `bun.lock`, Bun deleted the empty lockfile that did exist
and exited with status `0`. The build log records this as:

```text
bun install: ran, no-op (empty deps -> Bun 1.3.3 deletes empty lockfile
  -> recorded deviation)
```

This is consistent with Bun's documented behavior: the lockfile is a
cache of the resolved dependency graph; with zero dependencies the
cache is empty and the file is not materialized.

## Decision

Replace the unsatisfiable acceptance criterion with one that matches
observable behavior:

- **Old (plan §11 Gate C):** `bun.lock` exists.
- **New:** `bun install` exits `0` in the repo root.

For a zero-dependency repo, the verifiable signal is the exit status,
not the presence of `bun.lock`. Once any dependency is added (agent
SDK, test library, renderer), Bun will create the lockfile on the next
`bun install`, and that file then becomes the correct reproducibility
signal.

## Consequences

- **Positive:** Gate C becomes satisfiable on the first commit.
- **Positive:** CI continues to work identically. `bun install
  --frozen-lockfile` is a no-op when no lockfile is expected and
  becomes a real check the moment dependencies land.
- **Negative:** A reader of the plan must consult this ADR to reconcile
  the discrepancy. Mitigated by a forward pointer from the plan and the
  build log.
- **Neutral:** No change to runtime behavior. The agent runtime is still
  TypeScript under Bun; only the gate acceptance signal shifts.

## Alternatives considered

- **Add a placeholder devDependency solely to force lockfile
  materialization.** Rejected: the only value would be satisfying the
  prior criterion, which would introduce an unused dependency into the
  agent runtime layer.
- **Patch Bun to always write an empty lockfile.** Rejected: the upstream
  behavior is intentional and documented.

## Future deviations

This ADR is intentionally structured so additional plan-vs-reality
reconciliations can be appended below as they are observed. Each
entry should include: plan reference, observed behavior, decision.

### Deviation 2 — Subagent trio: `verifier`/`fixer`/`api-drift` instead of `api-drift`/`fuzzer`/`release-engineer`

> **🚫 SUPERSEDED 2026-05-05.** Per user direction "follow the actual plan
> `~/.claude/scratch/zig-quality-plan.md`" (and the integrated single source
> of truth established at scratch plan §0.13), the verifier/fixer trio is
> retired. Canonical subagent set per plan §3 + §10.5 row E is
> `api-drift`/`fuzzer`/`release-engineer` with model pins
> `haiku`/`sonnet`/`opus`. Reconciliation commit removes `zig-verifier.md`
> + `zig-fixer.md` and adds `zig-fuzzer.md` + `zig-release-engineer.md`
> with body text matching the rigor of the retained `zig-api-drift.md`
> (Zig wrapper resolution, untrusted-data boundary, Darwin fuzz
> degradation, structured output). Capability previously offered by
> verifier (clean JSON verdict) and fixer (worktree isolation, forbidden
> paths, bounded retries) is preserved indirectly via the main agent's
> direct gate invocation through the Stop hook + verify scripts. If live
> adopter experience demonstrates a real need to reintroduce them, they
> can be added as a v2 enhancement under a separate ADR. The historical
> deviation record below is preserved for forensic context.

- **Plan reference:** `~/.claude/scratch/zig-quality-plan.md` §3 lists
  the three retained subagents as `zig-api-drift`, `zig-fuzzer`,
  `zig-release-engineer`.
- **Prompt 3 reference:** the Prompt-3 `<execution>` block Group C step 14
  specified `zig-verifier`, `zig-fixer`, and `zig-api-drift` with explicit
  model pins and the `$PWD` worktree assertion on `zig-fixer`.
- **Observed decision:** followed Prompt 3 verbatim. The three agents
  delivered are `zig-verifier` (sonnet, read-only), `zig-fixer` (sonnet,
  worktree isolation), and `zig-api-drift` (haiku, read-only).
- **Trade-off recorded:** the plan's original `zig-fuzzer` and
  `zig-release-engineer` capabilities remain available via the main
  session invoking `bun scripts/verify-pr.ts` (bounded fuzz with Darwin
  degradation) and the `release/` task skill (user-invoked release flow).
  No capability was lost; only the subagent surface area is narrower.
- **Forward plan:** next plan revision should reconcile §3 with this
  delivered shape, or Prompt 4 should explicitly add `zig-fuzzer`/
  `zig-release-engineer` if the live adopter experience shows the main
  session is over-loaded.

### Deviation 3 — `scripts/lib/files.ts` fsWalk bugfix

- **Plan reference:** none (library code written during Group C).
- **Observed behavior:** the initial `fsWalk` fallback in
  `scripts/lib/files.ts` treated every entry in `CANDIDATE_DIRS` as a
  directory and called `Glob.scanSync({ cwd: entry })`. Two of those
  entries (`build.zig`, `build.zig.zon`) are files, not directories, so
  the glob scanner threw `ENOTDIR` and halted `verify-fast` whenever the
  repo had neither `jj files` nor `git ls-files` output (i.e. before the
  first commit).
- **Decision:** fix forward. Replaced `fsWalk` with a `statSync`-gated
  branch that treats files as single-entry results and only scans
  directories. Documented in commit `scripts: fix fsWalk to tolerate
  top-level file candidates`.
- **Consequence:** `verify-fast` now succeeds on a pristine
  `jj git init --colocate` repo with no commits.

### Deviation 4 — `tests/evals/thresholds.json` key shape

- **Plan reference:** none (agent-authored).
- **Observed behavior:** Agent E wrote thresholds under a nested
  `"domains": { ... }` key. `scripts/eval.ts` expected top-level keys
  per the spec in its own docstring. `bun scripts/eval.ts --check`
  failed for every domain.
- **Decision:** flatten to top-level keys. `eval --check` now exits 0.
  If future judge-backed eval execution needs versioning metadata, the
  `"version": 1` field at the top level already carries it.

### Template for future entries

- **Plan reference:** section or gate id
- **Observed behavior:** one-paragraph description tied to a build-log
  line
- **Decision:** amended acceptance criterion, forward plan for the next
  revision

## References

- Plan: `~/.claude/scratch/zig-quality-plan.md` §11 Group C step 1,
  Gate C acceptance line.
- Build log: `~/.claude/scratch/zig-quality-build.log` Group C
  checkpoint block.
- Bun docs: `https://bun.sh/docs/install/lockfile`.
