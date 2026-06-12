---
name: eval
description: Run the eval-tree structural checks and threshold policy. Use
  when the user asks to run evals, check fixture compliance, or validate
  trajectories. Wraps scripts/eval.ts via Bun.
argument-hint: "[--check|--report]"
user-invocable: true
allowed-tools: Bash(bun scripts/eval.ts:*)
---

# /eval — Eval Fixtures and Thresholds

This skill replaces the `/eval` command. It orchestrates
`scripts/eval.ts`, which validates the structured eval tree under
`tests/evals/` against `tests/evals/thresholds.json`.

## Default invocation

```
bun scripts/eval.ts --check
```

The `--check` flag runs structural checks only: fixture layout, required
files per domain, threshold-file schema, and trajectory JSONL well-formedness.
It does not call any external judge model.

## Eval tree layout

```
tests/evals/
├── thresholds.json              # domain → pass/fail thresholds
├── judge-prompt.md              # reserved for model-judge integration
├── domains/
│   ├── idioms/fixtures/              # Zig 0.16 idiom violations vs compliant
│   ├── allocator-discipline/fixtures/
│   ├── error-set-discipline/fixtures/
│   ├── io-injection/fixtures/        # std.Io boundary fixtures
│   ├── build-system/fixtures/        # build.zig.zon / graph fixtures
│   └── fuzz-target/fixtures/         # fuzz-target structure fixtures
└── trajectories/*.jsonl         # golden prompt/build trajectories
```

Each domain mirrors a quality axis enforced by the four-tier gate; evals
live per-domain, not per-skill, so the nested skill layout does not force
a flat eval mirror.

## Threshold policy

- `thresholds.json` is the single source of truth for pass/fail ratios per
  domain.
- Bumping a threshold requires commit-message justification (WHY/IMPACT).
- Lowering a threshold requires a paired fixture addition proving the new
  floor is not a regression window.

## Modes

| Mode | Effect |
|---|---|
| `--check` (default) | Structural + threshold validation; no model calls |
| `--report` | Emit a JSON summary of fixture counts, domain coverage, last run |

## Failure policy

- Missing domain dir, malformed threshold, or invalid JSONL trajectory →
  non-zero exit.
- Model-judge integration is deferred; do not add judge-call logic here.
- Eval failures do not gate `verify-fast`; they gate `verify-pr`.
