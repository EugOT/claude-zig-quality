# ADR 0005: Reproducible-build verification on Darwin (LC_UUID normalization)

- **Status:** Accepted
- **Date:** 2026-06-20
- **Deciders:** repo owner
- **Tags:** zig, reproducibility, darwin, macho, release, 0.16

## Context

The per-release gate (`scripts/verify-release.ts`) verifies a reproducible
build by performing two clean, non-incremental rebuilds and comparing a hash
of the artifacts under `zig-out/bin`. The intent is that identical source
produces identical artifacts.

This is **not true byte-for-byte on Darwin**, even with `SOURCE_DATE_EPOCH`
pinned. Measured empirically on `aarch64-macos` with the pinned Zig `0.16.0`:
two clean rebuilds of identical source produce binaries of identical size
(2,046,784 bytes) that differ in exactly **142 bytes across 6 regions**:

| Region (file offset) | Size | Identity |
|---|---|---|
| `@1808` | 16 B | Mach-O **`LC_UUID`** payload (random per link) |
| `@1671872` | 1 B | `__LINKEDIT` (symbol-table bookkeeping) |
| `@2021135` | 31 B | `__LINKEDIT` (symtab/string artifacts) |
| `@2042783`, `@2046047`, `@2046719` | 3 × 32 B | ad-hoc **code-signature** CodeDirectory page hashes |

Crucially, when the binary is decomposed by Mach-O **segment**, the only
non-deterministic bytes in the **loadable image** are the 16-byte `LC_UUID`
(which physically sits in the `__TEXT` segment's header area). The `__text`
code section and every `__DATA*` segment are **byte-identical** across builds.
All remaining variance lives in `__LINKEDIT` (symbol tables + the ad-hoc code
signature, which is itself derived from the UUID and the rest of the file) —
i.e. linker bookkeeping, not the program image.

`SOURCE_DATE_EPOCH` cannot fix this: the variance is the macOS linker's
per-link `LC_UUID` and signature, not timestamps. This is the same class of
platform limitation as ADR 0003 (Darwin fuzz), but unlike fuzz it has a clean
structural fix rather than requiring degradation.

## Decision

Two changes land together:

1. **Thread `SOURCE_DATE_EPOCH` through the rebuilds.** `verify-release.ts`
   computes one stable value (`sourceDateEpoch()`: explicit env override →
   HEAD commit time → fixed fallback) and passes it to **both** clean
   rebuilds via `zig(args, { SOURCE_DATE_EPOCH })`. This is necessary
   groundwork: on toolchains that *are* byte-reproducible (Linux/ELF), it is
   what makes timestamps deterministic. On Darwin it is necessary-but-not-
   sufficient.

2. **Normalize the reproducibility hash on Mach-O** (`normalizeForRepro()`).
   For a 64-bit Mach-O artifact, the hash is computed over the **loadable
   segments only** (excluding `__LINKEDIT` and `__PAGEZERO`), with the
   `LC_UUID` payload zeroed. The result is a deterministic digest of the
   actual code + data. Non-Mach-O artifacts (ELF, PE, wasm) pass through
   unchanged, so the **strict byte compare stays authoritative** on their
   native toolchains — notably Linux CI.

The parsing is structural (it walks load commands to find `LC_UUID` and the
segment table), not offset-hardcoded, so it is robust to binary-size changes.
The existing anti-aliasing framing (`path \0 size \0 bytes`) is preserved; the
normalization is applied to each file's bytes before framing.

## Consequences

- **Positive:** The reproducibility gate now gives a *true* signal on Darwin
  — it verifies the program image is reproducible while tolerating the
  linker's non-deterministic UUID/signature. Previously the gate would have
  always failed on Darwin if artifacts existed (it only "passed" via the
  no-artifacts skip path).
- **Positive:** A genuine `__text`/`__DATA` drift (a real reproducibility
  regression) is still detected — proven by a unit test that flips a loadable
  byte and confirms the normalized digest changes.
- **Positive:** Linux/ELF keeps the strictest possible check (raw bytes),
  because normalization is a no-op for non-Mach-O.
- **Negative:** The Darwin digest excludes `__LINKEDIT`, so a drift confined
  entirely to symbol tables would not be caught on Darwin. This is acceptable:
  `__LINKEDIT` is not part of the loaded program and its variance is
  linker-driven, not source-driven.
- **Negative:** The normalizer encodes Mach-O 64-bit LE structure knowledge.
  If Apple changes the format materially it must be revisited; mitigated by
  the structural (not offset-based) parse and the synthetic-Mach-O unit tests.

## Alternatives considered

- **Strict byte compare, accept Darwin failure / rely on the no-artifacts
  skip.** Rejected: the gate would lie (green only because nothing was hashed)
  or block every Darwin release.
- **Degrade the reproducibility gate on Darwin (mirror ADR 0003).** Rejected
  in favor of normalization: unlike fuzz, the non-determinism here is fully
  characterized and structurally separable, so we can keep a real check
  instead of a degraded notice. (Degradation remains the fallback if the
  format assumptions ever break.)
- **Hardcode the differing byte offsets and zero them.** Rejected: offsets
  shift with binary size; the structural load-command walk is robust.
- **Force a deterministic link (e.g. a fixed build-id / `--no-uuid`).**
  Investigated and deferred: Zig `0.16.0` does not expose a portable knob to
  suppress the macOS `LC_UUID` / ad-hoc signature, and patching the linker
  invocation is out of scope. Normalization achieves the same verification
  goal without fighting the toolchain.

## Validation

- `tests/unit/source-date-epoch.test.ts` — pins the `sourceDateEpoch()`
  resolution order (env override, non-numeric rejection, decimal-seconds
  output, stability across calls).
- `tests/unit/normalize-repro.test.ts` — synthetic Mach-O proves: two builds
  differing only in `LC_UUID` normalize equal; `__LINKEDIT` differences do
  not affect the digest; a genuine `__TEXT` byte flip DOES change the digest
  (normalization never masks real drift); non-Mach-O passes through unchanged.
- End-to-end: two real clean rebuilds with `SOURCE_DATE_EPOCH` pinned produce
  identical `hashDir(zig-out/bin)` digests (`GATE REPRODUCIBLE ✓`), whereas
  the raw-byte hash drifts.

## References

- ADR 0003 (`0003-darwin-fuzz-degradation.md`) — the sibling Darwin platform
  limitation and the "never lie" gate principle.
- `scripts/verify-release.ts` — `sourceDateEpoch()`, `normalizeForRepro()`,
  `hashDir()`.
- Mach-O `LC_UUID` / `LC_CODE_SIGNATURE`: Apple `mach-o/loader.h`.
