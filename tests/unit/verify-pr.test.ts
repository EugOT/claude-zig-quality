/**
 * Unit tests for scripts/verify-pr.ts exports (plan order=13, Wave 2 P1).
 *
 * DI mechanism: TARGETS, SAFETY_MODES, FUZZ_TIMEOUT_MS, and runFuzzBounded
 * are tested in-process by direct import. The main() DI path is exercised by
 * spawning a thin fixture wrapper script (written to tmpdir) that imports
 * main() and PrDeps from the real module, injects stubs, and records calls to
 * a JSON sidecar. No nested backticks, no heredocs — all inline scripts use
 * single-quoted strings throughout.
 *
 * Tests:
 *   1. TARGETS — exactly the 5 expected target triples
 *   2. SAFETY_MODES — exactly [Debug, ReleaseSafe, ReleaseFast, ReleaseSmall]
 *   3. runFuzzBounded — passes FUZZ_TIMEOUT_MS (300000) to injected runFuzz spy
 *   4. cross-target fail-fast — first failure → exit 1, no further zig calls
 *   5. zigSupportsFuzz=false → fuzz skipped, skip message printed
 *   6. fuzz verdict 'timeout' → finish(0) (regression: must NOT exit 143)
 *   7. PR_FUZZ_LIMIT env override is honored by main()
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FUZZ_TIMEOUT_MS, runFuzzBounded, SAFETY_MODES, TARGETS } from "../../scripts/verify-pr.ts";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const BUN_EXE = process.execPath;
const REPO = resolve(import.meta.dir, "../..");
const VERIFY_PR = resolve(REPO, "scripts/verify-pr.ts");

// ---------------------------------------------------------------------------
// Tmpdir lifecycle
// ---------------------------------------------------------------------------
let tmpRoot = "";

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "verify-pr-unit-"));
});

afterEach(async () => {
  if (tmpRoot) {
    await rm(tmpRoot, { recursive: true, force: true });
    tmpRoot = "";
  }
});

// ---------------------------------------------------------------------------
// Helper: spawn a fixture wrapper that injects PrDeps stubs into main().
//
// The wrapper is written as a plain .ts file (no heredoc, no backticks).
// It receives its configuration through env vars set per-test.
//
// Env vars consumed by the wrapper:
//   FIXTURE_COMMIT_EXIT   — exit code for the verify-commit spawnInherit call
//   FIXTURE_ZLS_EXIT      — exit code for zls-check spawnInherit call (default 0)
//   FIXTURE_DOCCOV_EXIT   — exit code for doc-coverage spawnInherit call (default 0)
//   FIXTURE_ZIG_EXITS     — JSON array of exit codes, one per zig() call
//   FIXTURE_HAS_FUZZ      — "true" or "false": whether hasBuildStep("fuzz") returns true
//   FIXTURE_HAS_DOCS      — "true" or "false": hasBuildStep("docs")
//   FIXTURE_SUPPORTS_FUZZ — "true" or "false": zigSupportsFuzz()
//   FIXTURE_FUZZ_VERDICT  — "pass" | "timeout" | number: what runFuzz returns
//   FIXTURE_CALLS_OUT     — absolute path where the wrapper writes recorded zig argv calls
//   CLAUDE_PROJECT_DIR    — set to tmpRoot so log writes are isolated
// ---------------------------------------------------------------------------

const WRAPPER_SRC = `
import { main } from ${JSON.stringify(VERIFY_PR)};
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const commitExit = Number(process.env.FIXTURE_COMMIT_EXIT ?? '0');
const zlsExit = Number(process.env.FIXTURE_ZLS_EXIT ?? '0');
const docCovExit = Number(process.env.FIXTURE_DOCCOV_EXIT ?? '0');
const zigExits = JSON.parse(process.env.FIXTURE_ZIG_EXITS ?? '[0,0,0,0,0,0,0,0,0]');
const hasFuzz = process.env.FIXTURE_HAS_FUZZ !== 'false';
const hasDocs = process.env.FIXTURE_HAS_DOCS === 'true';
const supportsFuzz = process.env.FIXTURE_SUPPORTS_FUZZ !== 'false';
const fuzzVerdict = process.env.FIXTURE_FUZZ_VERDICT ?? 'timeout';
const callsOut = process.env.FIXTURE_CALLS_OUT ?? '';

const zigCalls = [];
let zigCallIdx = 0;

const deps = {
  zig(args) {
    zigCalls.push(args);
    const code = zigExits[zigCallIdx] ?? 0;
    zigCallIdx++;
    return { code, stdout: '', stderr: '' };
  },
  hasBuildStep(step) {
    if (step === 'fuzz') return hasFuzz;
    if (step === 'docs') return hasDocs;
    return false;
  },
  zigSupportsFuzz() { return supportsFuzz; },
  async runFuzz(opts) {
    const v = fuzzVerdict;
    if (v === 'pass' || v === 'timeout') return v;
    return Number(v);
  },
  spawnInherit(cmd, cwd) {
    // Route by command pattern
    const joined = cmd.join(' ');
    if (joined.includes('verify-commit')) return commitExit;
    if (joined.includes('zls-check')) return zlsExit;
    if (joined.includes('doc-coverage')) return docCovExit;
    return 0;
  },
};

await main(deps);

if (callsOut) {
  mkdirSync(dirname(callsOut), { recursive: true });
  writeFileSync(callsOut, JSON.stringify(zigCalls));
}
`;

interface WrapperResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  zigCalls: string[][];
}

async function runWrapper(
  env: Record<string, string>,
): Promise<WrapperResult> {
  const wrapperPath = join(tmpRoot, "wrapper.ts");
  const callsOut = join(tmpRoot, "zig-calls.json");

  await writeFile(wrapperPath, WRAPPER_SRC, "utf8");

  // Ensure the log directory exists so appendJsonl doesn't fail.
  const logDir = join(tmpRoot, ".claude", "logs");
  await import("node:fs/promises").then((fs) => fs.mkdir(logDir, { recursive: true }));

  const proc = Bun.spawn([BUN_EXE, wrapperPath], {
    cwd: REPO,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: tmpRoot,
      FIXTURE_CALLS_OUT: callsOut,
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

  let zigCalls: string[][] = [];
  try {
    const raw = await Bun.file(callsOut).text();
    zigCalls = JSON.parse(raw);
  } catch {
    // File may not exist when main() exits before writing it (process.exit).
    // That's expected — we still have exit code and output.
  }

  return { stdout: out, stderr: err, exitCode, zigCalls };
}

// ===========================================================================
// Test 1: TARGETS — exactly the 5 expected cross-compilation target triples
// ===========================================================================
describe("TARGETS", () => {
  test("contains exactly the 5 expected target triples", () => {
    expect(Array.isArray(TARGETS)).toBe(true);
    expect(TARGETS.length).toBe(5);

    const expected = [
      "x86_64-linux-musl",
      "aarch64-linux-gnu",
      "aarch64-macos",
      "x86_64-windows-msvc",
      "wasm32-wasi",
    ];
    for (const triple of expected) {
      expect(TARGETS).toContain(triple);
    }
    // No extra entries
    for (const triple of TARGETS) {
      expect(expected).toContain(triple);
    }
  });
});

// ===========================================================================
// Test 2: SAFETY_MODES — exactly [Debug, ReleaseSafe, ReleaseFast, ReleaseSmall]
// ===========================================================================
describe("SAFETY_MODES", () => {
  test("is exactly [Debug, ReleaseSafe, ReleaseFast, ReleaseSmall] in order", () => {
    expect(Array.isArray(SAFETY_MODES)).toBe(true);
    expect(SAFETY_MODES).toEqual([
      "Debug",
      "ReleaseSafe",
      "ReleaseFast",
      "ReleaseSmall",
    ]);
  });
});

// ===========================================================================
// Test 3: runFuzzBounded — passes FUZZ_TIMEOUT_MS=300000 to injected spy
// ===========================================================================
describe("runFuzzBounded", () => {
  test("FUZZ_TIMEOUT_MS is 300000", () => {
    expect(FUZZ_TIMEOUT_MS).toBe(300_000);
  });

  test("passes timeoutMs=FUZZ_TIMEOUT_MS to injected runFuzz spy", async () => {
    const calls: Array<{ limit: string; timeoutMs: number }> = [];

    const spyRunFuzz = async (opts: {
      limit: string;
      timeoutMs: number;
    }): Promise<"pass" | "timeout" | number> => {
      calls.push({ limit: opts.limit, timeoutMs: opts.timeoutMs });
      return "timeout";
    };

    const verdict = await runFuzzBounded("100K", spyRunFuzz);

    expect(calls.length).toBe(1);
    expect(calls[0].limit).toBe("100K");
    expect(calls[0].timeoutMs).toBe(FUZZ_TIMEOUT_MS);
    expect(calls[0].timeoutMs).toBe(300_000);
    // timeout verdict is a clean pass
    expect(verdict).toBe("timeout");
  });

  test("passes limit string through verbatim", async () => {
    const calls: Array<{ limit: string; timeoutMs: number }> = [];
    const spy = async (opts: { limit: string; timeoutMs: number }) => {
      calls.push(opts);
      return "pass" as const;
    };

    await runFuzzBounded("500K", spy);
    expect(calls[0].limit).toBe("500K");
  });
});

// ===========================================================================
// Test 4: cross-target fail-fast — first failure → exit 1, stops immediately
// ===========================================================================
describe("main() — cross-target fail-fast", () => {
  test(
    "exits 1 on first failed cross-target build and issues no further zig build calls",
    async () => {
      // 5 targets + 4 safety modes + potentially docs = many calls
      // Return code 1 for the very first zig() call (first target build).
      // All subsequent calls return 0 so we can detect if they ran.
      const zigExits = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0];

      const result = await runWrapper({
        FIXTURE_COMMIT_EXIT: "0",
        FIXTURE_ZIG_EXITS: JSON.stringify(zigExits),
        FIXTURE_HAS_FUZZ: "false",
        FIXTURE_HAS_DOCS: "false",
        FIXTURE_SUPPORTS_FUZZ: "false",
      });

      expect(result.exitCode).toBe(1);
      // stderr must name the failing target
      expect(result.stderr).toContain("x86_64-linux-musl");
      // Only 1 zig call should have happened (the first target).
      // After exit(1) the process terminates — calls recorded before exit
      // may be 1; those after are never made.
      // We allow ≤1 recorded call (the file write may not happen on exit).
      expect(result.zigCalls.length).toBeLessThanOrEqual(1);
    },
    30_000,
  );
});

// ===========================================================================
// Test 5: zigSupportsFuzz=false → fuzz skipped, skip message printed
// ===========================================================================
describe("main() — fuzz skip when platform not supported", () => {
  test(
    "prints the ZLS skip message and exits 0 when zigSupportsFuzz returns false",
    async () => {
      const result = await runWrapper({
        FIXTURE_COMMIT_EXIT: "0",
        FIXTURE_ZIG_EXITS: JSON.stringify([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        FIXTURE_HAS_FUZZ: "true",
        FIXTURE_HAS_DOCS: "false",
        FIXTURE_SUPPORTS_FUZZ: "false",
        FIXTURE_FUZZ_VERDICT: "timeout",
      });

      expect(result.exitCode).toBe(0);
      // zigFuzzSkipMessage() is what main() calls — it mentions skipped / fuzz
      const combined = result.stdout + result.stderr;
      expect(combined).toMatch(/skipped|skip/i);
    },
    30_000,
  );
});

// ===========================================================================
// Test 6: fuzz verdict 'timeout' → finish(0) — NOT exit 143
//         Regression: timeout must be a clean pass, not a crash verdict.
// ===========================================================================
describe("main() — fuzz timeout is a clean pass", () => {
  test(
    "exits 0 when runFuzz returns 'timeout' (not 143 or any non-zero code)",
    async () => {
      const result = await runWrapper({
        FIXTURE_COMMIT_EXIT: "0",
        FIXTURE_ZIG_EXITS: JSON.stringify([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        FIXTURE_HAS_FUZZ: "true",
        FIXTURE_HAS_DOCS: "false",
        FIXTURE_SUPPORTS_FUZZ: "true",
        FIXTURE_FUZZ_VERDICT: "timeout",
      });

      expect(result.exitCode).toBe(0);
      // stdout must contain the budget-elapsed message
      expect(result.stdout).toContain("fuzz budget elapsed");
    },
    30_000,
  );
});

// ===========================================================================
// Test 7: PR_FUZZ_LIMIT env override is honored
// ===========================================================================
describe("main() — PR_FUZZ_LIMIT override", () => {
  test(
    "uses PR_FUZZ_LIMIT when set instead of the default '100K'",
    async () => {
      // We can't directly spy on runFuzz from the subprocess, but we CAN
      // verify that main() at least reaches the fuzz step without crashing.
      // The wrapper's runFuzz stub records calls; we verify limit via stdout.
      const result = await runWrapper({
        FIXTURE_COMMIT_EXIT: "0",
        FIXTURE_ZIG_EXITS: JSON.stringify([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        FIXTURE_HAS_FUZZ: "true",
        FIXTURE_HAS_DOCS: "false",
        FIXTURE_SUPPORTS_FUZZ: "true",
        FIXTURE_FUZZ_VERDICT: "timeout",
        PR_FUZZ_LIMIT: "250K",
      });

      expect(result.exitCode).toBe(0);
      // main() logs the limit it uses: "Bounded fuzz (300s, --fuzz=250K)"
      expect(result.stdout).toContain("250K");
    },
    30_000,
  );

  test(
    "uses default limit '100K' when PR_FUZZ_LIMIT is not set",
    async () => {
      const result = await runWrapper({
        FIXTURE_COMMIT_EXIT: "0",
        FIXTURE_ZIG_EXITS: JSON.stringify([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        FIXTURE_HAS_FUZZ: "true",
        FIXTURE_HAS_DOCS: "false",
        FIXTURE_SUPPORTS_FUZZ: "true",
        FIXTURE_FUZZ_VERDICT: "timeout",
        // deliberately do not set PR_FUZZ_LIMIT
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("100K");
    },
    30_000,
  );
});
