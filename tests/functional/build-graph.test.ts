/**
 * Functional tests for the build graph defined in build.zig.
 *
 * These tests drive the REAL `zig build` command against the REAL repo's
 * build.zig via subprocess.  No fixtures — the working directory is the
 * actual repo root.  All seven cases target distinct structural invariants
 * of the build graph and are regression-safe without editing source.
 *
 * Zig resolution: `mise x zig@0.16.0 -- zig` (or $ZIG if set, or
 * $ZLS_ZIG_EXE as a fallback probe).  Absence of the toolchain causes a
 * loud skip notice (never silently green — ADR 0003 principle).
 *
 * Tests (plan order=34):
 *   1. `zig build -l` lists all expected step names          (P0)
 *   2. `zig build test` exits 0 — full suite                 (P0, 180 s)
 *   3. `zig build test-unit` exits 0 — fast subset           (P0)
 *   4. `zig build fmt` exits 0 — no fmt drift                (P0)
 *   5. `zig build docs` produces zig-out/docs/               (P2)
 *   6. REGRESSION: lint is NOT a dependency of test          (P1)
 *   7. REGRESSION: exe_mod has zero .addImport calls         (P1)
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Repo root + toolchain resolution
// ---------------------------------------------------------------------------

/** Absolute path to the repo root (two levels up from tests/functional/). */
const REPO_ROOT = resolve(import.meta.dir, "../..");

/**
 * Resolve the zig command array.
 *
 * Priority:
 *   1. $ZIG env var (absolute path, operator override)
 *   2. `mise x zig@0.16.0 -- zig` (canonical pinned route)
 *
 * Returns either ["<abs-path-to-zig>"] or ["mise","x","zig@0.16.0","--","zig"].
 * Returns null when neither is available (triggers skip path).
 */
function resolveZigCmd(): string[] | null {
  const envZig = process.env["ZIG"];
  if (envZig && envZig.trim().length > 0) {
    return [envZig.trim()];
  }

  // Probe mise availability and zig@0.16.0 resolution.
  try {
    const probe = Bun.spawnSync(
      ["mise", "x", "zig@0.16.0", "--", "zig", "version"],
      { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
    );
    if (probe.exitCode === 0) {
      return ["mise", "x", "zig@0.16.0", "--", "zig"];
    }
  } catch {
    // mise not on PATH
  }
  return null;
}

const ZIG_CMD = resolveZigCmd();
const TOOLCHAIN_AVAILABLE = ZIG_CMD !== null;

// Two cases (full `zig build test` and the lint-not-a-test-dep regression) run
// the ENTIRE Zig suite as a subprocess — ~2-3 min each, and they contend on the
// shared .zig-cache when run concurrently with any other `zig build`. The full
// suite already runs in the per-commit gate, so re-running it inside `bun test`
// is redundant for the inner loop. Gate them behind an opt-in so the default
// lane stays fast; CI / the per-PR tier sets RUN_SLOW_BUILD_TESTS=1.
const RUN_SLOW_BUILD_TESTS = process.env["RUN_SLOW_BUILD_TESTS"] === "1";

/**
 * Build a full argv for `zig build <step> [...extra]`.
 * Throws if the toolchain was not resolved — callers must guard with
 * TOOLCHAIN_AVAILABLE before invoking.
 */
function zigBuildArgv(step: string, ...extra: string[]): string[] {
  if (!ZIG_CMD) throw new Error("zig toolchain not resolved");
  return [...ZIG_CMD, "build", step, ...extra];
}

// ---------------------------------------------------------------------------
// Subprocess runner
// ---------------------------------------------------------------------------

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function run(argv: string[], timeoutMs = 60_000): Promise<RunResult> {
  const proc = Bun.spawn(argv, {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  // Race the process against a hard timeout.
  const result = await Promise.race([
    (async (): Promise<RunResult> => {
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;
      return { stdout: out, stderr: err, exitCode };
    })(),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Process timed out after ${timeoutMs} ms: ${argv.join(" ")}`)),
        timeoutMs,
      )
    ),
  ]);
  return result;
}

/**
 * Emit a loud skip notice and return early.  Tests that call this pattern
 * register as passed (no expect() called) rather than silently green.
 */
function skipLoud(reason: string): void {
  console.warn(
    `[build-graph.test] SKIP: ${reason}\n` +
    "  Install zig 0.16.0 via `mise use -g zig@0.16.0` or set $ZIG to " +
    "the absolute path of the 0.16.0 binary to run these tests.",
  );
}

// ---------------------------------------------------------------------------
// Expected step names (authoritative from build.zig step("...") calls)
// ---------------------------------------------------------------------------

const EXPECTED_STEPS = [
  "fmt",
  "run",
  "test",
  "test-unit",
  "test-lib",
  "test-integration",
  "test-scripts",
  "fuzz",
  "docs",
  "lint",
] as const;

// ===========================================================================
// Tests
// ===========================================================================

describe("build-graph (zig build, real toolchain)", () => {
  // -------------------------------------------------------------------------
  // Test 1 — step list completeness (P0)
  // -------------------------------------------------------------------------
  test(
    "(1) zig build -l lists all expected steps",
    async () => {
      if (!TOOLCHAIN_AVAILABLE) {
        skipLoud("no zig toolchain resolvable");
        return;
      }

      const { stdout, stderr, exitCode } = await run(
        zigBuildArgv("-l"),
        30_000,
      );

      // `zig build -l` exits 0 on success.
      if (exitCode !== 0) {
        console.error("stdout:", stdout);
        console.error("stderr:", stderr);
      }
      expect(exitCode).toBe(0);

      const combined = stdout + stderr;

      // Every step name must appear as a word in the output.
      for (const step of EXPECTED_STEPS) {
        expect(combined).toContain(step);
      }
    },
    30_000,
  );

  // -------------------------------------------------------------------------
  // Test 2 — full test suite exits 0 (P0, slow)
  // -------------------------------------------------------------------------
  test(
    "(2) zig build test exits 0 (full suite, including script-tool tests)",
    async () => {
      if (!TOOLCHAIN_AVAILABLE) {
        skipLoud("no zig toolchain resolvable");
        return;
      }
      if (!RUN_SLOW_BUILD_TESTS) {
        skipLoud(
          "full `zig build test` is a slow lane — set RUN_SLOW_BUILD_TESTS=1 (per-commit gate already runs it)",
        );
        return;
      }

      const { stdout, stderr, exitCode } = await run(
        zigBuildArgv("test"),
        300_000,
      );

      if (exitCode !== 0) {
        console.error("=== zig build test stdout ===\n" + stdout);
        console.error("=== zig build test stderr ===\n" + stderr);
      }

      // Success is exit 0 and a "Build Summary: N/N tests passed" line.
      // The suite intentionally includes tests that produce lines like
      // "huge.zig StreamTooLong" and "phantom.zig FileNotFound" — those
      // are expected-passing fixtures, not failures.  Do NOT assert
      // absence of those strings.
      // Exit 0 is the authoritative success signal. The "Build Summary" line
      // is printed only when steps actually EXECUTE — a fully-cached run emits
      // no summary at all, so requiring it would flake on cache state. Assert
      // the summary shape ONLY when a summary was printed (cold run), and always
      // assert exit 0.
      expect(exitCode).toBe(0);

      const combined = stdout + stderr;
      if (combined.includes("Build Summary")) {
        expect(combined).toMatch(/Build Summary:.*(?:passed|succeeded)/i);
      }
    },
    300_000,
  );

  // -------------------------------------------------------------------------
  // Test 3 — test-unit subset exits 0 (P0)
  // -------------------------------------------------------------------------
  test(
    "(3) zig build test-unit exits 0 (fast unit subset)",
    async () => {
      if (!TOOLCHAIN_AVAILABLE) {
        skipLoud("no zig toolchain resolvable");
        return;
      }

      const { stdout, stderr, exitCode } = await run(
        zigBuildArgv("test-unit"),
        60_000,
      );

      if (exitCode !== 0) {
        console.error("stdout:", stdout);
        console.error("stderr:", stderr);
      }
      expect(exitCode).toBe(0);
    },
    60_000,
  );

  // -------------------------------------------------------------------------
  // Test 4 — fmt check exits 0 (no drift) (P0)
  // -------------------------------------------------------------------------
  test(
    "(4) zig build fmt exits 0 (no formatting drift)",
    async () => {
      if (!TOOLCHAIN_AVAILABLE) {
        skipLoud("no zig toolchain resolvable");
        return;
      }

      const { stdout, stderr, exitCode } = await run(
        zigBuildArgv("fmt"),
        30_000,
      );

      if (exitCode !== 0) {
        console.error("stdout:", stdout);
        console.error("stderr:", stderr);
      }
      expect(exitCode).toBe(0);
    },
    30_000,
  );

  // -------------------------------------------------------------------------
  // Test 5 — docs step produces output directory (P2)
  // -------------------------------------------------------------------------
  test(
    "(5) zig build docs produces zig-out/docs/ with content",
    async () => {
      if (!TOOLCHAIN_AVAILABLE) {
        skipLoud("no zig toolchain resolvable");
        return;
      }

      const { stdout, stderr, exitCode } = await run(
        zigBuildArgv("docs"),
        60_000,
      );

      if (exitCode !== 0) {
        console.error("stdout:", stdout);
        console.error("stderr:", stderr);
      }
      expect(exitCode).toBe(0);

      // The docs step installs into zig-out/docs/ (install_dir = .prefix,
      // install_subdir = "docs").  Assert the directory exists and is
      // non-empty — index.html presence is best-effort since Zig 0.16's
      // doc emitter may name the entry point differently.
      const docsDir = resolve(REPO_ROOT, "zig-out", "docs");
      expect(existsSync(docsDir)).toBe(true);

      const entries = readdirSync(docsDir);
      expect(entries.length).toBeGreaterThan(0);
    },
    60_000,
  );

  // -------------------------------------------------------------------------
  // Test 6 — REGRESSION: lint is NOT a dependency of the test step (P1)
  //
  // Method: run `zig build test --summary all` and assert that ziglint-
  // specific markers ("ziglint", "ReleaseFast") do not appear in its
  // combined output.  ziglint is compiled with optimize=ReleaseFast when
  // the lint step runs; its absence from the test step's summary proves
  // no transitive dependency exists.
  //
  // This directly validates the build.zig comment:
  //   "Kept OUT of `test_step` on purpose: per-turn verify-fast stays
  //    sub-second"
  // -------------------------------------------------------------------------
  test(
    "(6) REGRESSION: zig build test does not invoke ziglint (lint not a test dep)",
    async () => {
      if (!TOOLCHAIN_AVAILABLE) {
        skipLoud("no zig toolchain resolvable");
        return;
      }
      if (!RUN_SLOW_BUILD_TESTS) {
        skipLoud(
          "runs the full `zig build test` — set RUN_SLOW_BUILD_TESTS=1 to include",
        );
        return;
      }

      const { stdout, stderr, exitCode } = await run(
        zigBuildArgv("test", "--summary", "all"),
        300_000,
      );

      if (exitCode !== 0) {
        console.error("stdout:", stdout);
        console.error("stderr:", stderr);
      }
      expect(exitCode).toBe(0);

      const combined = stdout + stderr;

      // ziglint is compiled with -Doptimize=ReleaseFast when the lint step
      // runs.  If the lint step were a transitive dependency of test, the
      // summary would include a compile step referencing "ziglint" or the
      // ReleaseFast build of it.  Neither must appear.
      expect(combined.toLowerCase()).not.toContain("ziglint");

      // Secondary check: the lint step description ("Run ziglint over
      // sources and build files") must not appear in the test step summary.
      expect(combined).not.toContain("Run ziglint");
    },
    300_000,
  );

  // -------------------------------------------------------------------------
  // Test 7 — REGRESSION: exe_mod has zero .addImport calls (source grep) (P1)
  //
  // build.zig creates exe_mod with b.createModule(…) and passes it to
  // b.addExecutable(…).  The module is intentionally self-contained —
  // no inter-module wiring via .addImport is documented for the root exe.
  // This test reads build.zig as text and asserts that no `.addImport`
  // call appears between the exe_mod creation and the exe creation block.
  //
  // Method: static text analysis of build.zig (no subprocess needed).
  // We locate the exe_mod declaration, find the exe instantiation, and
  // assert the slice between them contains no ".addImport".
  // -------------------------------------------------------------------------
  test(
    "(7) REGRESSION: exe_mod has zero .addImport calls in build.zig",
    () => {
      const buildZigPath = resolve(REPO_ROOT, "build.zig");
      const buildZigText = readFileSync(buildZigPath, "utf8");

      // Locate exe_mod creation.
      const exeModStart = buildZigText.indexOf("const exe_mod = b.createModule(");
      expect(exeModStart).toBeGreaterThanOrEqual(0);

      // Locate exe creation immediately after exe_mod.
      const exeStart = buildZigText.indexOf(
        "const exe = b.addExecutable(",
        exeModStart,
      );
      expect(exeStart).toBeGreaterThanOrEqual(0);
      expect(exeStart).toBeGreaterThan(exeModStart);

      // The slice between exe_mod and exe must not contain ".addImport".
      const sliceBetween = buildZigText.slice(exeModStart, exeStart);
      expect(sliceBetween).not.toContain(".addImport");

      // Broader check: exe_mod itself is never passed to .addImport anywhere
      // in the entire build.zig (confirming it has no inter-module imports).
      // lib_mod and hello_mod also have no .addImport in this build.zig —
      // all three modules are kept strictly self-contained.
      const allImportCalls = [...buildZigText.matchAll(/\.addImport\s*\(/g)];
      expect(allImportCalls.length).toBe(0);
    },
    // Pure synchronous test — 5 s ceiling is generous.
    5_000,
  );
});
