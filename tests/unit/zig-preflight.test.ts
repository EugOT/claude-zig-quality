/**
 * Unit tests for .claude/hooks/pretooluse-zig-preflight.ts
 *
 * STRATEGY: These are pure subprocess tests — we spawn the hook binary and
 * feed it a JSON payload on stdin, then assert the exit code and stdout JSON.
 * No real Zig toolchain is required here; all the pass-through shapes exit
 * before the `zig ast-check` call is ever reached.
 *
 * Test numbering aligns with the task plan (order = 22, tests 1-5).
 */

import { describe, expect, test, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// Absolute path to the hook so tests work from any cwd.
const HOOK = resolve(
  import.meta.dir,
  "../../.claude/hooks/pretooluse-zig-preflight.ts",
);
const BUN_EXE = process.execPath;

// A single tmpdir that all unit tests route log writes into so the repo's
// .claude/logs/ is never touched by the test suite.
let logDir: string;

// We create the logDir before any test runs and clean it up after the suite.
async function ensureLogDir(): Promise<string> {
  if (!logDir) {
    logDir = await mkdtemp(resolve(tmpdir(), "zig-preflight-unit-"));
  }
  return logDir;
}

afterAll(async () => {
  if (logDir) {
    await rm(logDir, { recursive: true, force: true });
  }
});

/**
 * Spawn the hook binary with `payload` as its stdin.
 * CLAUDE_PROJECT_DIR is redirected to `projectDir` so log writes land there.
 */
async function runHook(
  payload: unknown,
  projectDir?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number; parsed: unknown }> {
  const dir = projectDir ?? (await ensureLogDir());
  const input = JSON.stringify(payload);
  const proc = Bun.spawn([BUN_EXE, HOOK], {
    stdin: new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: dir,
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

// ===========================================================================
// Pass-through shapes — no zig toolchain involved
// ===========================================================================
describe("pass-through (no zig needed)", () => {
  // -------------------------------------------------------------------------
  // Test 1: non-.zig file on Write → allow
  // -------------------------------------------------------------------------
  test("(1) Write to 'main.ts' (non-.zig) → {continue:true}, exit 0", async () => {
    const payload = {
      tool_name: "Write",
      tool_input: {
        file_path: "/workspace/main.ts",
        content: "console.log('hello');",
      },
    };
    const { parsed, exitCode } = await runHook(payload);
    expect(exitCode).toBe(0);
    expect(parsed).toEqual({ continue: true });
  });

  // -------------------------------------------------------------------------
  // Test 2: Edit on a .zig file → allow (preflight only validates Write)
  // -------------------------------------------------------------------------
  test("(2) Edit on main.zig → {continue:true}, exit 0 (Edit passes through)", async () => {
    const payload = {
      tool_name: "Edit",
      tool_input: {
        file_path: "/workspace/main.zig",
        old_string: "const x = 1;",
        new_string: "const x = 2;",
      },
    };
    const { parsed, exitCode } = await runHook(payload);
    expect(exitCode).toBe(0);
    expect(parsed).toEqual({ continue: true });
  });

  // -------------------------------------------------------------------------
  // Test 3: MultiEdit on a .zig file → allow
  // -------------------------------------------------------------------------
  test("(3) MultiEdit on main.zig → {continue:true}, exit 0 (MultiEdit passes through)", async () => {
    const payload = {
      tool_name: "MultiEdit",
      tool_input: {
        file_path: "/workspace/main.zig",
        edits: [
          { old_string: "const x = 1;", new_string: "const x = 2;" },
          { old_string: "const y = 1;", new_string: "const y = 2;" },
        ],
      },
    };
    const { parsed, exitCode } = await runHook(payload);
    expect(exitCode).toBe(0);
    expect(parsed).toEqual({ continue: true });
  });

  // -------------------------------------------------------------------------
  // Test 4: Write with empty content → allow (guard exits before ast-check)
  // -------------------------------------------------------------------------
  test("(4) Write to .zig with empty content → {continue:true}, exit 0", async () => {
    const payload = {
      tool_name: "Write",
      tool_input: {
        file_path: "/workspace/main.zig",
        content: "",
      },
    };
    const { parsed, exitCode } = await runHook(payload);
    expect(exitCode).toBe(0);
    expect(parsed).toEqual({ continue: true });
  });

  // -------------------------------------------------------------------------
  // Test 5: Write with missing content field → allow
  // -------------------------------------------------------------------------
  test("(5) Write to .zig with missing content field → {continue:true}, exit 0", async () => {
    const payload = {
      tool_name: "Write",
      tool_input: {
        file_path: "/workspace/main.zig",
        // content is intentionally absent
      },
    };
    const { parsed, exitCode } = await runHook(payload);
    expect(exitCode).toBe(0);
    expect(parsed).toEqual({ continue: true });
  });
});
