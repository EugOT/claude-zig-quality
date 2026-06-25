/**
 * Unit + subprocess tests for .claude/hooks/stop-dod.ts.
 *
 * STRATEGY:
 *   (A) SUBPROCESS — wire-protocol and anti-loop branches. We spawn
 *       `bun .claude/hooks/stop-dod.ts` with a piped JSON stdin payload
 *       and CLAUDE_PROJECT_DIR pointing at a tmp directory so log writes
 *       never touch the real repo. For the runDodGate-injected verdict
 *       branches, the real verify-commit.ts would be too expensive and
 *       non-deterministic inside a test, so we use approach (B).
 *
 *   (B) SUBPROCESS WRAPPER via `bun -e` — imports main() from the hook,
 *       passes a stub RunDodGate that returns a fixed SpawnResult, feeds a
 *       JSON payload on stdin, then we assert on stdout + exit code.
 *       This lets us test every verdict branch without touching PATH or the
 *       real verify-commit tier.
 *
 * All subprocess wrappers are plain inline strings — no nested backticks.
 */

import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const REPO = resolve(import.meta.dir, "../..");
const HOOK = resolve(REPO, ".claude/hooks/stop-dod.ts");
const BUN_EXE = process.execPath;

// ---------------------------------------------------------------------------
// Tmp directory — every test that writes logs points CLAUDE_PROJECT_DIR here
// so the real repo's .claude/logs/ is never touched.
// ---------------------------------------------------------------------------
const TMP = mkdtempSync(join(tmpdir(), "stop-dod-test-"));

afterAll(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

// ---------------------------------------------------------------------------
// Helper A: spawn the hook directly, feeding `payload` on stdin.
// ---------------------------------------------------------------------------
async function runHook(
  payload: unknown,
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number; parsed: unknown }> {
  const input = JSON.stringify(payload);
  const proc = Bun.spawn([BUN_EXE, HOOK], {
    stdin: new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: TMP,
      ...env,
    },
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(out.trim());
  } catch {
    parsed = null;
  }
  return { stdout: out, stderr: err, exitCode, parsed };
}

// ---------------------------------------------------------------------------
// Helper B: spawn a `bun -e` wrapper that imports main() and calls it with a
// stub RunDodGate returning `spawnResult`. The wrapper reads from stdin so the
// hook's readStdinJson() works normally.
//
// IMPORTANT: the inline script uses only single-quoted strings internally so
// we can embed it in a JS template literal without any nested backtick issues.
// ---------------------------------------------------------------------------
async function runHookWithStub(
  payload: unknown,
  spawnResult: { code: number | null; stdout: string; stderr: string },
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number; parsed: unknown }> {
  const resultJson = JSON.stringify(spawnResult);
  // We pass the SpawnResult as an env var to avoid quoting complexity.
  const script = `
import { main } from '${HOOK}';
const r = JSON.parse(process.env.__STUB_RESULT__);
await main(() => r);
`;
  const input = JSON.stringify(payload);
  const proc = Bun.spawn([BUN_EXE, "-e", script], {
    stdin: new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: TMP,
      __STUB_RESULT__: resultJson,
      ...env,
    },
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(out.trim());
  } catch {
    parsed = null;
  }
  return { stdout: out, stderr: err, exitCode, parsed };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("stop-dod hook", () => {
  // -------------------------------------------------------------------------
  // Test 1: stop_hook_active:true → exits 0 without running the DoD gate.
  // We verify the gate is NOT called by using a wrapper script that records
  // invocations to a marker file; if the file is absent, the gate was skipped.
  // -------------------------------------------------------------------------
  test("(1) stop_hook_active:true → exits 0 immediately, gate NOT invoked", async () => {
    const markerFile = join(TMP, "gate-called-1.marker");
    const script = `
import { main } from '${HOOK}';
import { writeFileSync } from 'node:fs';
let called = false;
await main(() => {
  writeFileSync('${markerFile}', '1');
  called = true;
  return { code: 0, stdout: '', stderr: '' };
});
`;
    const input = JSON.stringify({ stop_hook_active: true });
    const proc = Bun.spawn([BUN_EXE, "-e", script], {
      stdin: new TextEncoder().encode(input),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CLAUDE_PROJECT_DIR: TMP },
    });
    await proc.exited;
    const exitCode = proc.exitCode;
    expect(exitCode).toBe(0);
    expect(existsSync(markerFile)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 2: stop_hook_active:false → the gate IS invoked.
  // -------------------------------------------------------------------------
  test("(2) stop_hook_active:false → gate is invoked", async () => {
    const markerFile = join(TMP, "gate-called-2.marker");
    const script = `
import { main } from '${HOOK}';
import { writeFileSync } from 'node:fs';
await main(() => {
  writeFileSync('${markerFile}', '1');
  return { code: 0, stdout: 'ok', stderr: '' };
});
`;
    const input = JSON.stringify({ stop_hook_active: false });
    const proc = Bun.spawn([BUN_EXE, "-e", script], {
      stdin: new TextEncoder().encode(input),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CLAUDE_PROJECT_DIR: TMP },
    });
    await proc.exited;
    expect(existsSync(markerFile)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 3: {} (missing field) → gate is invoked (falsy default path).
  // -------------------------------------------------------------------------
  test("(3) {} (missing stop_hook_active) → gate is invoked", async () => {
    const markerFile = join(TMP, "gate-called-3.marker");
    const script = `
import { main } from '${HOOK}';
import { writeFileSync } from 'node:fs';
await main(() => {
  writeFileSync('${markerFile}', '1');
  return { code: 0, stdout: 'ok', stderr: '' };
});
`;
    const input = JSON.stringify({});
    const proc = Bun.spawn([BUN_EXE, "-e", script], {
      stdin: new TextEncoder().encode(input),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CLAUDE_PROJECT_DIR: TMP },
    });
    await proc.exited;
    expect(existsSync(markerFile)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 4: stop_hook_active:'true' (string, not boolean true) → gate runs.
  // The guard checks `=== true` (strict equality), so a string does not match.
  // -------------------------------------------------------------------------
  test("(4) stop_hook_active:'true' (string) → gate is invoked (strict === false)", async () => {
    const markerFile = join(TMP, "gate-called-4.marker");
    const script = `
import { main } from '${HOOK}';
import { writeFileSync } from 'node:fs';
await main(() => {
  writeFileSync('${markerFile}', '1');
  return { code: 0, stdout: 'ok', stderr: '' };
});
`;
    const input = JSON.stringify({ stop_hook_active: "true" });
    const proc = Bun.spawn([BUN_EXE, "-e", script], {
      stdin: new TextEncoder().encode(input),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CLAUDE_PROJECT_DIR: TMP },
    });
    await proc.exited;
    expect(existsSync(markerFile)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 5: gate returns code:0 (pass) → exit 0, NO block JSON on stdout.
  // -------------------------------------------------------------------------
  test("(5) gate returns code:0 → exit 0, no block decision on stdout", async () => {
    const { exitCode, parsed, stdout } = await runHookWithStub(
      { stop_hook_active: false },
      { code: 0, stdout: "all good", stderr: "" },
    );
    expect(exitCode).toBe(0);
    // stdout must be empty (no JSON decision emitted on pass)
    expect(stdout.trim()).toBe("");
    expect(parsed).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Test 6: gate returns code:1 (fail) → stdout has decision:'block' and
  // reason includes 'Definition-of-Done gate failed'.
  // -------------------------------------------------------------------------
  test("(6) gate returns code:1 → decision:'block', reason includes DoD text", async () => {
    const { exitCode, parsed } = await runHookWithStub(
      { stop_hook_active: false },
      { code: 1, stdout: "", stderr: "test failed: something broke" },
    );
    expect(exitCode).toBe(0);
    const out = parsed as { decision?: string; reason?: string };
    expect(out?.decision).toBe("block");
    expect(out?.reason).toContain("Definition-of-Done gate failed");
  });

  // -------------------------------------------------------------------------
  // Test 7: block reason includes the stderr tail from the gate result.
  // -------------------------------------------------------------------------
  test("(7) block reason includes stderr tail from the gate result", async () => {
    const stderrText = "FATAL: zig build test — 3 tests failed";
    const { parsed } = await runHookWithStub(
      { stop_hook_active: false },
      { code: 1, stdout: "some stdout", stderr: stderrText },
    );
    const out = parsed as { reason?: string };
    // stderr is preferred over stdout in the tail (test 9 validates this
    // further; here we just confirm the stderr content appears)
    expect(out?.reason).toContain(stderrText);
  });

  // -------------------------------------------------------------------------
  // Test 8: stop_hook_active:true logs a 'stop-active-allow' event to
  // .claude/logs/stop-dod.jsonl under CLAUDE_PROJECT_DIR.
  // -------------------------------------------------------------------------
  test("(8) stop_hook_active:true → logs stop-active-allow event to JSONL", async () => {
    // Use a dedicated tmp dir so we can read the log cleanly.
    const logTmp = mkdtempSync(join(tmpdir(), "stop-dod-log-"));
    try {
      const script = `
import { main } from '${HOOK}';
await main(() => ({ code: 0, stdout: '', stderr: '' }));
`;
      const input = JSON.stringify({ stop_hook_active: true });
      const proc = Bun.spawn([BUN_EXE, "-e", script], {
        stdin: new TextEncoder().encode(input),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, CLAUDE_PROJECT_DIR: logTmp },
      });
      await proc.exited;

      const logPath = join(logTmp, ".claude/logs/stop-dod.jsonl");
      expect(existsSync(logPath)).toBe(true);
      const lines = readFileSync(logPath, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));
      const found = lines.some(
        (l: { event?: string }) => l.event === "stop-active-allow",
      );
      expect(found).toBe(true);
    } finally {
      rmSync(logTmp, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Test 9: when gate result has both stdout and stderr, stderr is preferred
  // in the tail (regression — the hook uses `r.stderr || r.stdout`).
  // -------------------------------------------------------------------------
  test("(9) when both stdout and stderr are non-empty, stderr appears in block reason", async () => {
    const stderrContent = "UNIQUE_STDERR_CONTENT_9";
    const stdoutContent = "UNIQUE_STDOUT_CONTENT_9";
    const { parsed } = await runHookWithStub(
      { stop_hook_active: false },
      { code: 1, stdout: stdoutContent, stderr: stderrContent },
    );
    const out = parsed as { reason?: string };
    // The hook does `tail(r.stderr || r.stdout)`, so stderr wins when present.
    expect(out?.reason).toContain(stderrContent);
    expect(out?.reason).not.toContain(stdoutContent);
  });

  // -------------------------------------------------------------------------
  // Test 10: gate returns code:null → treated as failure → block path.
  // (Regression: null exit code from a crashed subprocess should block.)
  // -------------------------------------------------------------------------
  test("(10) gate returns code:null → treated as failure → decision:'block'", async () => {
    const { exitCode, parsed } = await runHookWithStub(
      { stop_hook_active: false },
      { code: null, stdout: "", stderr: "subprocess crashed" },
    );
    expect(exitCode).toBe(0);
    const out = parsed as { decision?: string; reason?: string };
    expect(out?.decision).toBe("block");
    expect(out?.reason).toContain("Definition-of-Done gate failed");
  });
});
