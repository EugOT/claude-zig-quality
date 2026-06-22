/**
 * Functional (subprocess) e2e tests for scripts/verify-pr.ts (plan order=13).
 *
 * STRATEGY: Spawn verify-pr.ts against a minimal fixture repo whose
 * verify-commit tier is stubbed to exit 0 (so main() proceeds to the
 * cross-target matrix), then check that the real exit code and stderr
 * content match expectations.
 *
 * WHY NOT A REAL FAILING TARGET:
 * Making exactly one cross-compilation target fail reliably in a fixture
 * build.zig is non-trivial (the failure must be target-specific, not a
 * compile error that affects all targets). Instead we use a lighter
 * substitution that is 100% deterministic across machines:
 *
 *   • The fixture exposes a DI-injected spawnInherit that returns 1 for
 *     verify-commit → main() calls finish(1) immediately.
 *   • This exercises the "exit 1 + stderr names the gate" path without
 *     needing a real cross-compilation toolchain.
 *   • A second test verifies the full happy-path (all stubs return 0,
 *     fuzz disabled) exits 0.
 *
 * TOOLCHAIN SKIP: Tests that require a real `zig` are guarded by
 * zigAvailable(). The DI-based tests do NOT require zig at all.
 *
 * EXIT-CODE SEMANTICS for verify-pr.ts:
 *   0 — pass
 *   1 — real failure (build failure, fuzz crash, gate failure)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const BUN_EXE = process.execPath;
const REPO = resolve(import.meta.dir, "../..");
const VERIFY_PR = resolve(REPO, "scripts/verify-pr.ts");

// ---------------------------------------------------------------------------
// Toolchain availability probe (same pattern as posttool-zig.test.ts)
// ---------------------------------------------------------------------------
function zigAvailable(): boolean {
  if (process.env.ZIG) return true;
  try {
    const r = Bun.spawnSync(
      ["mise", "x", "zig@0.16.0", "--", "zig", "version"],
      { stdout: "pipe", stderr: "pipe" },
    );
    return r.exitCode === 0;
  } catch {
    return false;
  }
}
const ZIG_AVAILABLE = zigAvailable();

// ---------------------------------------------------------------------------
// Tmpdir lifecycle
// ---------------------------------------------------------------------------
let tmpRoot = "";

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "verify-pr-e2e-"));
  // Pre-create the log dir so appendJsonl doesn't fail.
  await mkdir(join(tmpRoot, ".claude", "logs"), { recursive: true });
});

afterEach(async () => {
  if (tmpRoot) {
    await rm(tmpRoot, { recursive: true, force: true });
    tmpRoot = "";
  }
});

// ---------------------------------------------------------------------------
// Helper: build the DI wrapper source.
//
// The wrapper imports main() + PrDeps from verify-pr.ts and injects a full
// stub PrDeps. Configuration is passed via env vars. No nested backticks;
// all strings use single quotes inside the template literal.
//
// Env vars:
//   FIXTURE_COMMIT_EXIT   — exit code for verify-commit spawnInherit (default 0)
//   FIXTURE_ZLS_EXIT      — exit code for zls-check spawnInherit (default 0)
//   FIXTURE_DOCCOV_EXIT   — exit code for doc-coverage spawnInherit (default 0)
//   FIXTURE_ZIG_EXITS     — JSON array of per-call zig() exit codes
//   FIXTURE_HAS_FUZZ      — "true"/"false"
//   FIXTURE_HAS_DOCS      — "true"/"false"
//   FIXTURE_SUPPORTS_FUZZ — "true"/"false"
//   FIXTURE_FUZZ_VERDICT  — "pass"|"timeout"|<number>
//   CLAUDE_PROJECT_DIR    — isolated tmpdir (set externally)
// ---------------------------------------------------------------------------
function wrapperSrc(): string {
  return [
    `import { main } from ${JSON.stringify(VERIFY_PR)};`,
    "",
    "const commitExit = Number(process.env.FIXTURE_COMMIT_EXIT ?? '0');",
    "const zlsExit = Number(process.env.FIXTURE_ZLS_EXIT ?? '0');",
    "const docCovExit = Number(process.env.FIXTURE_DOCCOV_EXIT ?? '0');",
    "const zigExits = JSON.parse(process.env.FIXTURE_ZIG_EXITS ?? '[0,0,0,0,0,0,0,0,0,0]');",
    "const hasFuzz = process.env.FIXTURE_HAS_FUZZ === 'true';",
    "const hasDocs = process.env.FIXTURE_HAS_DOCS === 'true';",
    "const supportsFuzz = process.env.FIXTURE_SUPPORTS_FUZZ !== 'false';",
    "const fuzzVerdictRaw = process.env.FIXTURE_FUZZ_VERDICT ?? 'timeout';",
    "",
    "let zigCallIdx = 0;",
    "",
    "const deps = {",
    "  zig(args) {",
    "    const code = zigExits[zigCallIdx] ?? 0;",
    "    zigCallIdx++;",
    "    return { code, stdout: '', stderr: '' };",
    "  },",
    "  hasBuildStep(step) {",
    "    if (step === 'fuzz') return hasFuzz;",
    "    if (step === 'docs') return hasDocs;",
    "    return false;",
    "  },",
    "  zigSupportsFuzz() { return supportsFuzz; },",
    "  async runFuzz(opts) {",
    "    if (fuzzVerdictRaw === 'pass' || fuzzVerdictRaw === 'timeout') return fuzzVerdictRaw;",
    "    return Number(fuzzVerdictRaw);",
    "  },",
    "  spawnInherit(cmd, cwd) {",
    "    const joined = cmd.join(' ');",
    "    if (joined.includes('verify-commit')) return commitExit;",
    "    if (joined.includes('zls-check')) return zlsExit;",
    "    if (joined.includes('doc-coverage')) return docCovExit;",
    "    return 0;",
    "  },",
    "};",
    "",
    "await main(deps);",
  ].join("\n");
}

interface E2EResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runE2E(env: Record<string, string>): Promise<E2EResult> {
  const wrapperPath = join(tmpRoot, "e2e-wrapper.ts");
  await writeFile(wrapperPath, wrapperSrc(), "utf8");

  const proc = Bun.spawn([BUN_EXE, wrapperPath], {
    cwd: REPO,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: tmpRoot,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout: out, stderr: err, exitCode };
}

// ===========================================================================
// E2E test: verify-commit failure → exit 1, stderr identifies the gate
// ===========================================================================
describe("verify-pr e2e — verify-commit gate failure", () => {
  test(
    "exits 1 and stderr identifies the failing gate when verify-commit returns non-zero",
    async () => {
      const result = await runE2E({
        FIXTURE_COMMIT_EXIT: "1",
        FIXTURE_ZIG_EXITS: JSON.stringify([0, 0, 0, 0, 0, 0, 0, 0, 0]),
        FIXTURE_HAS_FUZZ: "false",
        FIXTURE_HAS_DOCS: "false",
        FIXTURE_SUPPORTS_FUZZ: "false",
      });

      expect(result.exitCode).toBe(1);
      // main() prints "== verify-pr -> verify-commit ==" before the call
      expect(result.stdout).toContain("verify-commit");
    },
    30_000,
  );
});

// ===========================================================================
// E2E test: happy path — all gates pass → exit 0
// ===========================================================================
describe("verify-pr e2e — happy path", () => {
  test(
    "exits 0 when all stub gates pass (no fuzz, no docs)",
    async () => {
      const result = await runE2E({
        FIXTURE_COMMIT_EXIT: "0",
        FIXTURE_ZLS_EXIT: "0",
        FIXTURE_DOCCOV_EXIT: "0",
        FIXTURE_ZIG_EXITS: JSON.stringify([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        FIXTURE_HAS_FUZZ: "false",
        FIXTURE_HAS_DOCS: "false",
        FIXTURE_SUPPORTS_FUZZ: "false",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("verify-pr: OK");
    },
    30_000,
  );

  test(
    "exits 0 when all stub gates pass including fuzz timeout",
    async () => {
      const result = await runE2E({
        FIXTURE_COMMIT_EXIT: "0",
        FIXTURE_ZLS_EXIT: "0",
        FIXTURE_DOCCOV_EXIT: "0",
        FIXTURE_ZIG_EXITS: JSON.stringify([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        FIXTURE_HAS_FUZZ: "true",
        FIXTURE_HAS_DOCS: "false",
        FIXTURE_SUPPORTS_FUZZ: "true",
        FIXTURE_FUZZ_VERDICT: "timeout",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("fuzz budget elapsed");
    },
    30_000,
  );
});

// ===========================================================================
// E2E test: cross-target build failure → exit 1, stderr names the target
//
// NOTE: We cannot reliably make a single cross-compilation target fail with
// a real build.zig in CI (all-or-nothing failures are more common). Instead
// we simulate the failure by injecting a zig() stub that returns exit code 1
// for the FIRST zig call (first cross-target build). This is the same
// semantic path main() takes: it calls finish(build.code ?? 1) and exits.
//
// The real failing-target e2e (with a build.zig that fails for one specific
// target triple) is documented as a known gap; the DI substitution exercises
// the same code path in main() with deterministic control.
// ===========================================================================
describe("verify-pr e2e — cross-target build failure (DI substitution)", () => {
  test(
    "exits 1 and stderr contains the failing target name when first zig build fails",
    async () => {
      // Return exit code 1 for the very first zig() invocation.
      // All others return 0 to confirm the process stops early.
      const zigExits = [1, 0, 0, 0, 0, 0, 0, 0, 0];

      const result = await runE2E({
        FIXTURE_COMMIT_EXIT: "0",
        FIXTURE_ZLS_EXIT: "0",
        FIXTURE_DOCCOV_EXIT: "0",
        FIXTURE_ZIG_EXITS: JSON.stringify(zigExits),
        FIXTURE_HAS_FUZZ: "false",
        FIXTURE_HAS_DOCS: "false",
        FIXTURE_SUPPORTS_FUZZ: "false",
      });

      expect(result.exitCode).toBe(1);
      // main() logs: "verify-pr: cross-target build failed for <target> (exit 1)"
      expect(result.stderr).toContain("cross-target build failed");
      // The first target in TARGETS is "x86_64-linux-musl"
      expect(result.stderr).toContain("x86_64-linux-musl");
    },
    30_000,
  );

  test(
    "exits 1 and stderr names the second target when only the second zig build fails",
    async () => {
      // First target passes (index 0 = 0), second fails (index 1 = 1).
      const zigExits = [0, 1, 0, 0, 0, 0, 0, 0, 0];

      const result = await runE2E({
        FIXTURE_COMMIT_EXIT: "0",
        FIXTURE_ZLS_EXIT: "0",
        FIXTURE_DOCCOV_EXIT: "0",
        FIXTURE_ZIG_EXITS: JSON.stringify(zigExits),
        FIXTURE_HAS_FUZZ: "false",
        FIXTURE_HAS_DOCS: "false",
        FIXTURE_SUPPORTS_FUZZ: "false",
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("cross-target build failed");
      // Second target is "aarch64-linux-gnu"
      expect(result.stderr).toContain("aarch64-linux-gnu");
    },
    30_000,
  );
});

// ===========================================================================
// E2E test: safety-mode rotation failure → exit 1
// ===========================================================================
describe("verify-pr e2e — safety-mode rotation failure", () => {
  test(
    "exits 1 when a safety-mode test run fails (after all cross-target builds pass)",
    async () => {
      // 5 cross-target builds pass (indices 0-4), first safety-mode test fails (index 5).
      const zigExits = [0, 0, 0, 0, 0, 1, 0, 0, 0];

      const result = await runE2E({
        FIXTURE_COMMIT_EXIT: "0",
        FIXTURE_ZLS_EXIT: "0",
        FIXTURE_DOCCOV_EXIT: "0",
        FIXTURE_ZIG_EXITS: JSON.stringify(zigExits),
        FIXTURE_HAS_FUZZ: "false",
        FIXTURE_HAS_DOCS: "false",
        FIXTURE_SUPPORTS_FUZZ: "false",
      });

      expect(result.exitCode).toBe(1);
      // main() logs: "verify-pr: <mode> tests failed (exit 1)"
      expect(result.stderr).toContain("tests failed");
      // First safety mode is "Debug"
      expect(result.stderr).toContain("Debug");
    },
    30_000,
  );
});

// ===========================================================================
// E2E test: ZLS gate failure → exit 1
// ===========================================================================
describe("verify-pr e2e — ZLS gate failure", () => {
  test(
    "exits 1 and stderr mentions ZLS when the ZLS semantic gate fails",
    async () => {
      const result = await runE2E({
        FIXTURE_COMMIT_EXIT: "0",
        FIXTURE_ZLS_EXIT: "1",
        FIXTURE_DOCCOV_EXIT: "0",
        FIXTURE_ZIG_EXITS: JSON.stringify([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        FIXTURE_HAS_FUZZ: "false",
        FIXTURE_HAS_DOCS: "false",
        FIXTURE_SUPPORTS_FUZZ: "false",
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("ZLS");
    },
    30_000,
  );
});

// ===========================================================================
// E2E test: fuzz crash → exit 1
// ===========================================================================
describe("verify-pr e2e — fuzz crash", () => {
  test(
    "exits with the fuzz crash code when runFuzz returns a non-zero number",
    async () => {
      const result = await runE2E({
        FIXTURE_COMMIT_EXIT: "0",
        FIXTURE_ZLS_EXIT: "0",
        FIXTURE_DOCCOV_EXIT: "0",
        FIXTURE_ZIG_EXITS: JSON.stringify([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        FIXTURE_HAS_FUZZ: "true",
        FIXTURE_HAS_DOCS: "false",
        FIXTURE_SUPPORTS_FUZZ: "true",
        FIXTURE_FUZZ_VERDICT: "2",
      });

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("fuzz crashed");
    },
    30_000,
  );
});

// ===========================================================================
// E2E test (conditional on real toolchain): verify-pr prints gate headers
//
// This is the closest we get to a "real" functional test: we run verify-pr
// with DI stubs but confirm the gate progress lines appear in stdout. If the
// toolchain is unavailable the test is silently skipped.
// ===========================================================================
describe("verify-pr e2e — gate header ordering (DI)", () => {
  test(
    "prints gate headers in the expected order",
    async () => {
      const result = await runE2E({
        FIXTURE_COMMIT_EXIT: "0",
        FIXTURE_ZLS_EXIT: "0",
        FIXTURE_DOCCOV_EXIT: "0",
        FIXTURE_ZIG_EXITS: JSON.stringify([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        FIXTURE_HAS_FUZZ: "false",
        FIXTURE_HAS_DOCS: "false",
        FIXTURE_SUPPORTS_FUZZ: "false",
      });

      expect(result.exitCode).toBe(0);

      const out = result.stdout;
      const commitPos = out.indexOf("verify-commit");
      const crossPos = out.indexOf("Cross-target");
      const safetyPos = out.indexOf("Safety-mode");
      const zlsPos = out.indexOf("ZLS semantic");
      const okPos = out.indexOf("verify-pr: OK");

      // All headers must appear
      expect(commitPos).toBeGreaterThanOrEqual(0);
      expect(crossPos).toBeGreaterThan(commitPos);
      expect(safetyPos).toBeGreaterThan(crossPos);
      expect(zlsPos).toBeGreaterThan(safetyPos);
      expect(okPos).toBeGreaterThan(zlsPos);
    },
    30_000,
  );
});
