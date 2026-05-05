# ADR 0004: DORA metrics tracking

- **Status:** Accepted
- **Date:** 2026-05-01
- **Deciders:** repo owner
- **Tags:** metrics, dora, tooling, schema

## Context

The four-tier gate topology is the operator-facing reliability surface,
but the operator also needs a small, durable, machine-readable signal
that the gates are buying real outcomes — not just enforcing local
discipline. The DORA program (Deployment Frequency, Lead Time for
Changes, Change Failure Rate, Mean Time to Restore) remains the
canonical compact summary of delivery performance, and a single JSON
file is the cheapest format an editor, a CI step, a Forgejo
notification, or a manual audit can all read without bespoke parsers.

`.agent/dora.json` is the live state file. Its current shape is:

```json
{
  "deploys_per_week": 0,
  "lead_time_hours": null,
  "change_fail_rate": null,
  "mttr_hours": null
}
```

`null` indicates "not yet measured" rather than a true zero. Once the
release flow runs end-to-end, the values stabilize.

## Decision

- Track DORA metrics in `.agent/dora.json` at the repo root.
- Constrain the file's shape with a JSON Schema at
  `doc/schemas/dora.schema.json`, drafted against
  `https://json-schema.org/draft/2020-12/schema`.
- Keep the four canonical keys: `deploys_per_week`, `lead_time_hours`,
  `change_fail_rate`, `mttr_hours`.
- Allow `null` for any metric that has not yet been measured. Once a
  measurement exists it is a non-negative number; `change_fail_rate`
  is additionally bounded to the closed interval `[0, 1]`.
- Treat `.agent/` as the canonical location for agent-readable runtime
  state (sibling to `.claude/logs/` for hook output). The file is
  human-editable but tooling-owned.

## Rationale

- **Why DORA:** the four metrics compress an enormous research base
  into a contract small enough for a JSON file. They are the standard
  cross-team comparison surface and are language-agnostic, so they
  carry across the eight follow-on languages without modification.
- **Why this format:** flat keys keep the file diffable in PRs and
  greppable from any shell. A schema in `doc/schemas/` keeps validation
  declarative and out of script bodies.
- **Why `.agent/`:** the directory is reserved for agent-managed state
  that is neither a hook log nor a skill body. Future additions (e.g.
  a session-state snapshot) live alongside.

## Consequences

- **Positive:** any tool — verify scripts, Forgejo workflows, dashboards
  — can validate `.agent/dora.json` against `doc/schemas/dora.schema.json`
  without re-implementing the contract. CodeRabbit and reviewers see a
  documented format instead of a bare data file.
- **Positive:** schema validation catches typos (`mttr_hour` vs
  `mttr_hours`) and out-of-range values (`change_fail_rate: 1.5`)
  before a metric reaches a dashboard.
- **Negative:** a writer of `.agent/dora.json` must keep schema and
  data in sync. Mitigated by checking in both files together and
  treating schema drift as a code-review concern.
- **Neutral:** no runtime change. The verify scripts do not yet read
  this file; they will once the release flow lands.

## Format

The authoritative shape is defined in
[`doc/schemas/dora.schema.json`](../schemas/dora.schema.json).
Required keys: `deploys_per_week`, `lead_time_hours`,
`change_fail_rate`, `mttr_hours`. Each accepts a non-negative number
or `null`. `change_fail_rate` is additionally constrained to `[0, 1]`.

## Alternatives considered

- **Bare data file with no schema.** Rejected: every reader would
  re-implement the contract, drift is silent, and reviewers have no
  surface to push back against.
- **Embed metrics in `package.json` or a chezmoi-managed config.**
  Rejected: metrics are runtime state, not package metadata. Mixing
  concerns would couple tooling that should stay independent.
- **Use a richer format (Prometheus, OpenMetrics).** Rejected for v0:
  the cost of a metrics backend exceeds the value of four numbers.
  This decision can be revisited once the release flow is live.

## References

- ADR 0001: `doc/adr/0001-plan-deviations.md` (precedent for ADR style)
- Schema: `doc/schemas/dora.schema.json`
- Live state: `.agent/dora.json`
- DORA research program: <https://dora.dev/>
