/**
 * Unit tests for scripts/verify-commit.ts (plan order=12, Wave 2).
 *
 * STRATEGY — DI subprocess wrapper via `bun -e`:
 *   verify-commit exports `main(deps: CommitDeps)`. We cannot call main()
 *   in-process because it terminates with process.exit() via finish(). Instead
 *   each test spawns a `bun -e <script>` child where <script>:
 *     1. imports main from the absolute source path
 *     2. builds a stub CommitDeps object (spawnInherit, zig, hasBuildStep,
 *        fileExists) whose return values are scripted via env vars
 *     3. calls await main(deps)
 *   We then assert the child's exit code and stdout/stderr.
 *
 *   Env-var plumbing avoids nested backtick / quoting issues: every stub
 *   return value is serialised to JSON and passed through __STUB_* env vars.
 *   The inline script reads them back with JSON.parse(process.env.__STUB_*)
 *   and builds the corresponding stub function.
 *
 *   Side-effect: main() calls appendJsonl() which writes to
 *   .claude/logs/verify.jsonl under CLAUDE_PROJECT_DIR. We point
 *   CLAUDE_PROJECT_DIR at a per-test tmpdir so the real repo is never touched.
 */

import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const REPO = resolve(import.meta.dir, "../..");
const SCRIPT = resolve(REPO, "scripts/verify-commit.ts");
const BUN_EXE = process.execPath;

// ---------------------------------------------------------------------------
// Shared tmp directory — CLAUDE_PROJECT_DIR points here so log writes stay
// out of the real repo.
// ---------------------------------------------------------------------------
const TMP = mkdtempSync(join(tmpdir(), "verify-commit-unit-"));

afterAll(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// ---------------------------------------------------------------------------
// Helper: run verify-commit's main() in a child process with fully stubbed
// CommitDeps. Each stub field is controlled by a JSON env var:
//
//   __STUB_SPAWN__  — array of { match: string; code: number|null } rules.
//                     spawnInherit(cmd) returns the first matching rule's code
//                     (matched by cmd.join(' ').includes(match)), or 0 if none.
//   __STUB_ZIG__    — { code: number|null; stdout: string; stderr: string }
//                     returned by every zig() call.
//   __STUB_HAS_BUILD_STEP__ — boolean returned by hasBuildStep().
//   __STUB_FILE_EXISTS__    — boolean returned by fileExists().
//
// Call records for zig() and spawnInherit() are written to stdout as
// "CALL:zig:<args>" and "CALL:spawn:<cmd>" lines so tests can assert
// which calls were (not) made.
// ---------------------------------------------------------------------------
interface SpawnRule {
  match: string;
  code: number | null;
}

interface StubConfig {
  spawnRules?: SpawnRule[];
  zigResult?: { code: number | null; stdout: string; stderr: string };
  hasBuildStep?: boolean;
  fileExists?: boolean;
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runWithStubs(cfg: StubConfig = {}): Promise<RunResult> {
  const spawnRules: SpawnRule[] = cfg.spawnRules ?? [];
  const zigResult = cfg.zigResult ?? { code: 0, stdout: "", stderr: "" };
  const hasBuildStep = cfg.hasBuildStep ?? false;
  const fileExists = cfg.fileExists ?? false;

  // Build the inline script as an array of lines — no nested backticks.
  const lines = [
    "import { main } from '" + SCRIPT + "';",
    "const spawnRules = JSON.parse(process.env.__STUB_SPAWN__ || '[]');",
    "const zigResult  = JSON.parse(process.env.__STUB_ZIG__);",
    "const hasBuildStepVal = JSON.parse(process.env.__STUB_HBS__);",
    "const fileExistsVal   = JSON.parse(process.env.__STUB_FE__);",
    "",
    "function spawnInherit(cmd, cwd) {",
    "  const flat = cmd.join(' ');",
    "  process.stdout.write('CALL:spawn:' + flat + '\\n');",
    "  for (const rule of spawnRules) {",
    "    if (flat.includes(rule.match)) return rule.code;",
    "  }",
    "  return 0;",
    "}",
    "",
    "function zigStub(args) {",
    "  process.stdout.write('CALL:zig:' + args.join(' ') + '\\n');",
    "  return zigResult;",
    "}",
    "",
    "const deps = {",
    "  zig: zigStub,",
    "  hasBuildStep: () => hasBuildStepVal,",
    "  spawnInherit,",
    "  fileExists: () => Promise.resolve(fileExistsVal),",
    "};",
    "",
    "await main(deps);",
  ];

  const script = lines.join("\n");

  const proc = Bun.spawn([BUN_EXE, "-e", script], {
    cwd: TMP,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: TMP,
      __STUB_SPAWN__: JSON.stringify(spawnRules),
      __STUB_ZIG__: JSON.stringify(zigResult),
      __STUB_HBS__: JSON.stringify(hasBuildStep),
      __STUB_FE__: JSON.stringify(fileExists),
    },
  });

  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout: out, stderr: err, exitCode };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("verify-commit unit (DI subprocess wrapper)", () => {
  // -------------------------------------------------------------------------
  // Test 1: hasBuildStep('lint') = false → `zig build lint` is NEVER called.
  // We assert no CALL:zig:build lint line appears in stdout.
  // -------------------------------------------------------------------------
  test("(1) hasBuildStep=false → zig build lint is never called", async () => {
    const { stdout, exitCode } = await runWithStubs({
      hasBuildStep: false,
      fileExists: false,
      zigResult: { code: 0, stdout: "", stderr: "" },
      spawnRules: [],
    });

    // The lint-skip notice must appear.
    expect(stdout).toContain("no `lint` build step");
    // No zig() call with 'build lint' args.
    const lintCall = stdout
      .split("\n")
      .some((l) => l.startsWith("CALL:zig:") && l.includes("build lint"));
    expect(lintCall).toBe(false);
    expect(exitCode).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Test 2: fileExists('src/lib.zig') = false → check-public-api.ts is NOT
  // spawned. We assert no CALL:spawn line contains 'check-public-api'.
  // -------------------------------------------------------------------------
  test("(2) fileExists=false → check-public-api.ts is never spawned", async () => {
    const { stdout, exitCode } = await runWithStubs({
      hasBuildStep: false,
      fileExists: false,
      zigResult: { code: 0, stdout: "", stderr: "" },
      spawnRules: [],
    });

    const apiCall = stdout
      .split("\n")
      .some((l) => l.startsWith("CALL:spawn:") && l.includes("check-public-api"));
    expect(apiCall).toBe(false);
    // The skip notice must appear instead.
    expect(stdout).toContain("no src/lib.zig");
    expect(exitCode).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Test 3: verify-fast subprocess returns exit code 2 → main exits 2.
  // spawnInherit is stubbed to return 2 when the cmd matches verify-fast.ts.
  // -------------------------------------------------------------------------
  test("(3) verify-fast returns 2 → child exits 2", async () => {
    const { exitCode } = await runWithStubs({
      hasBuildStep: false,
      fileExists: false,
      zigResult: { code: 0, stdout: "", stderr: "" },
      spawnRules: [{ match: "verify-fast.ts", code: 2 }],
    });

    expect(exitCode).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Test 4: zig() returns code:null → null-coalesced to 1 → child exits 1.
  // (Regression: a crashed subprocess returning null must not silently pass.)
  // verify-fast must pass first (code 0), then zig() for build test returns null.
  // -------------------------------------------------------------------------
  test("(4) zig build test returns code:null → finish(1) → child exits 1", async () => {
    const { exitCode, stderr } = await runWithStubs({
      hasBuildStep: false,
      fileExists: false,
      zigResult: { code: null, stdout: "", stderr: "subprocess crashed" },
      // verify-fast passes (default 0)
      spawnRules: [],
    });

    expect(exitCode).toBe(1);
    // The null-exit diagnostic should appear somewhere in stderr.
    expect(stderr).toContain("zig build test failed");
  });

  // -------------------------------------------------------------------------
  // Test 5: clean path — all stubs return success → exit 0, stdout contains
  // 'verify-commit: OK'. Both lint (hasBuildStep=true) and api check
  // (fileExists=true) run and pass so the happy path is fully exercised.
  // -------------------------------------------------------------------------
  test("(5) clean path: all stubs pass → exit 0 + 'verify-commit: OK'", async () => {
    const { stdout, exitCode } = await runWithStubs({
      hasBuildStep: true,
      fileExists: true,
      zigResult: { code: 0, stdout: "", stderr: "" },
      // verify-fast passes and check-public-api passes (default 0)
      spawnRules: [],
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("verify-commit: OK");
    // Both gates ran: we should see zig build test AND zig build lint calls.
    const zigCalls = stdout.split("\n").filter((l) => l.startsWith("CALL:zig:"));
    const hasTest = zigCalls.some((l) => l.includes("build test"));
    const hasLint = zigCalls.some((l) => l.includes("build lint"));
    expect(hasTest).toBe(true);
    expect(hasLint).toBe(true);
    // check-public-api was spawned.
    const hasApi = stdout
      .split("\n")
      .some((l) => l.startsWith("CALL:spawn:") && l.includes("check-public-api"));
    expect(hasApi).toBe(true);
  });
});
