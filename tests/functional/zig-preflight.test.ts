/**
 * Functional tests for .claude/hooks/pretooluse-zig-preflight.ts
 *
 * STRATEGY: Spawn the real hook binary with real Zig 0.16.0 (via mise).
 * Tests are skipped when no pinned toolchain is resolvable so CI on bare
 * hosts degrades loudly rather than silently.
 *
 * Skip floor: `mise x zig@0.16.0 -- zig version` must succeed OR $ZIG must
 * point to a 0.16.0 binary. On this repo's CI node mise IS available, so all
 * 6 functional tests are expected to RUN (not skip).
 *
 * Test numbering aligns with the task plan (order = 22, tests 6-11).
 */

import { describe, expect, test, afterAll } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const HOOK = resolve(
  import.meta.dir,
  "../../.claude/hooks/pretooluse-zig-preflight.ts",
);
const BUN_EXE = process.execPath;

// ---------------------------------------------------------------------------
// Toolchain detection — determines whether functional tests run or skip.
// We probe the same resolution chain that scripts/lib/zig.ts uses at runtime
// so the skip condition mirrors the hook's own behaviour exactly.
// ---------------------------------------------------------------------------
function hasZig(): boolean {
  const envZig = process.env.ZIG;
  if (envZig && envZig.length > 0) {
    // $ZIG is set — trust the operator.
    const r = Bun.spawnSync([envZig, "version"], { stdout: "pipe", stderr: "pipe" });
    return r.exitCode === 0;
  }
  if (Bun.which("mise") !== null) {
    const r = Bun.spawnSync(
      ["mise", "x", "zig@0.16.0", "--", "zig", "version"],
      { stdout: "pipe", stderr: "pipe" },
    );
    return r.exitCode === 0;
  }
  // Bare-PATH zig is not a reliable probe (§0.7) — treat as absent.
  return false;
}

const ZIG_AVAILABLE = hasZig();

// All per-suite tmpdirs; cleaned up in afterAll.
const allTmpDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    allTmpDirs.map((d) => rm(d, { recursive: true, force: true })),
  );
});

/**
 * Create a fresh tmpdir that acts as CLAUDE_PROJECT_DIR for one test.
 * The hook's appendJsonl resolves log paths relative to this dir, so each
 * test gets an isolated log and no tests share state.
 */
async function makeProjectDir(): Promise<string> {
  const d = await mkdtemp(resolve(tmpdir(), "zig-preflight-func-"));
  // Pre-create the .claude/logs directory so appendJsonl can write immediately.
  await mkdir(resolve(d, ".claude", "logs"), { recursive: true });
  allTmpDirs.push(d);
  return d;
}

/**
 * Spawn the hook with a given JSON payload, routing all log writes to
 * `projectDir`.  Returns stdout, stderr, exit code, and parsed JSON output.
 */
async function runHook(
  payload: unknown,
  projectDir: string,
): Promise<{ stdout: string; stderr: string; exitCode: number; parsed: unknown }> {
  const input = JSON.stringify(payload);
  const proc = Bun.spawn([BUN_EXE, HOOK], {
    stdin: new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: projectDir,
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

/** Read the JSONL log and parse every line into an object. */
async function readLog(projectDir: string): Promise<Record<string, unknown>[]> {
  const logPath = resolve(projectDir, ".claude", "logs", "zig-preflight.jsonl");
  let text: string;
  try {
    text = await readFile(logPath, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ===========================================================================
// Functional tests — real zig toolchain required
// ===========================================================================
describe("functional (real zig toolchain)", () => {
  // -------------------------------------------------------------------------
  // Test 6: valid Zig source → allow + log event='pass'
  // -------------------------------------------------------------------------
  test(
    "(6) Write valid Zig source → {continue:true} + log event='pass'",
    async () => {
      const projectDir = await makeProjectDir();
      const validZig = `const std = @import("std");\n\npub fn main() !void {\n    const stdout = std.io.getStdOut().writer();\n    try stdout.print("hello\\n", .{});\n}\n`;
      const payload = {
        tool_name: "Write",
        tool_input: {
          file_path: "/workspace/main.zig",
          content: validZig,
        },
      };
      const { parsed, exitCode } = await runHook(payload, projectDir);
      expect(exitCode).toBe(0);
      expect(parsed).toEqual({ continue: true });

      // Verify the log entry records event='pass'
      const lines = await readLog(projectDir);
      expect(lines.length).toBeGreaterThanOrEqual(1);
      const last = lines[lines.length - 1];
      expect(last.event).toBe("pass");
      expect(last.file).toBe("/workspace/main.zig");
      expect(last.tool).toBe("Write");
      expect(last.code).toBe(0);
    },
    // mise startup adds latency; give each functional test a generous budget
    20_000,
  );

  // -------------------------------------------------------------------------
  // Test 7: invalid Zig source → deny, reason names the file
  // -------------------------------------------------------------------------
  test(
    "(7) Write invalid Zig ('const x = ;') → permissionDecision:'deny', reason names file",
    async () => {
      const projectDir = await makeProjectDir();
      const invalidZig = "const x = ;\n";
      const payload = {
        tool_name: "Write",
        tool_input: {
          file_path: "/workspace/broken.zig",
          content: invalidZig,
        },
      };
      const { parsed, exitCode } = await runHook(payload, projectDir);
      expect(exitCode).toBe(0);

      // The hook emits a pre-tool-decision deny wrapped in hookSpecificOutput.
      const out = parsed as {
        hookSpecificOutput?: {
          permissionDecision?: string;
          permissionDecisionReason?: string;
        };
      };
      expect(out?.hookSpecificOutput?.permissionDecision).toBe("deny");
      // The reason must mention the target file path.
      expect(out?.hookSpecificOutput?.permissionDecisionReason).toContain(
        "/workspace/broken.zig",
      );

      // Log entry must record event='fail'
      const lines = await readLog(projectDir);
      expect(lines.length).toBeGreaterThanOrEqual(1);
      const last = lines[lines.length - 1];
      expect(last.event).toBe("fail");
    },
    20_000,
  );

  // -------------------------------------------------------------------------
  // Test 8: temp file is cleaned up on pass (no leftover preflight-*.zig)
  // -------------------------------------------------------------------------
  test(
    "(8) Temp file is cleaned up after a passing ast-check",
    async () => {
      const projectDir = await makeProjectDir();
      const validZig = `const std = @import("std");\npub fn add(a: u32, b: u32) u32 { return a + b; }\n`;
      const payload = {
        tool_name: "Write",
        tool_input: {
          file_path: "/workspace/add.zig",
          content: validZig,
        },
      };
      await runHook(payload, projectDir);

      // Scan the system tmpdir for leftover preflight-*.zig files.
      // The hook always cleans up in `finally`, so none should remain.
      const systemTmp = tmpdir();
      const entries = await readdir(systemTmp);
      const leftovers = entries.filter(
        (e) => e.startsWith("preflight-") && e.endsWith(".zig"),
      );
      // There may be lingering files from other unrelated processes, but there
      // should be none that are both brand-new and match. We assert the count
      // of *freshly created* files by checking mtime within the last 5 seconds.
      const now = Date.now();
      const fresh = (
        await Promise.all(
          leftovers.map(async (name) => {
            try {
              const stat = await Bun.file(resolve(systemTmp, name)).stat();
              return stat.mtime.getTime() > now - 5_000 ? name : null;
            } catch {
              return null;
            }
          }),
        )
      ).filter((n): n is string => n !== null);
      expect(fresh).toHaveLength(0);
    },
    20_000,
  );

  // -------------------------------------------------------------------------
  // Test 9: temp file is cleaned up after a failing ast-check
  // -------------------------------------------------------------------------
  test(
    "(9) Temp file is cleaned up after a failing ast-check",
    async () => {
      const projectDir = await makeProjectDir();
      const invalidZig = "const y = ;\n";
      const payload = {
        tool_name: "Write",
        tool_input: {
          file_path: "/workspace/bad.zig",
          content: invalidZig,
        },
      };
      await runHook(payload, projectDir);

      const systemTmp = tmpdir();
      const entries = await readdir(systemTmp);
      const leftovers = entries.filter(
        (e) => e.startsWith("preflight-") && e.endsWith(".zig"),
      );
      const now = Date.now();
      const fresh = (
        await Promise.all(
          leftovers.map(async (name) => {
            try {
              const stat = await Bun.file(resolve(systemTmp, name)).stat();
              return stat.mtime.getTime() > now - 5_000 ? name : null;
            } catch {
              return null;
            }
          }),
        )
      ).filter((n): n is string => n !== null);
      expect(fresh).toHaveLength(0);
    },
    20_000,
  );

  // -------------------------------------------------------------------------
  // Test 10: concurrent invocations use distinct UUID tmp names
  // (run 3 in parallel, assert no collision/corruption)
  // -------------------------------------------------------------------------
  test(
    "(10) Concurrent invocations use distinct UUID tmp names (no collision)",
    async () => {
      const projectDir = await makeProjectDir();
      // Three valid Zig snippets, each slightly different.
      const sources = [
        `pub fn a() u32 { return 1; }\n`,
        `pub fn b() u32 { return 2; }\n`,
        `pub fn c() u32 { return 3; }\n`,
      ];
      const results = await Promise.all(
        sources.map((content) =>
          runHook(
            {
              tool_name: "Write",
              tool_input: { file_path: "/workspace/concurrent.zig", content },
            },
            projectDir,
          ),
        ),
      );

      // All three invocations must complete cleanly (allow).
      for (const { parsed, exitCode } of results) {
        expect(exitCode).toBe(0);
        expect(parsed).toEqual({ continue: true });
      }

      // Three distinct log entries must have been appended, each with
      // event='pass'. This confirms three independent ast-check runs
      // completed (distinct UUIDs → no shared temp file → no corruption).
      const lines = await readLog(projectDir);
      const passes = lines.filter((l) => l.event === "pass");
      expect(passes.length).toBeGreaterThanOrEqual(3);
    },
    30_000,
  );

  // -------------------------------------------------------------------------
  // Test 11: diagnostic tail bounded to ~1500 chars on a long error
  // -------------------------------------------------------------------------
  test(
    "(11) Long ast-check diagnostic is tail-truncated to ≤ 1600 chars in the deny reason",
    async () => {
      const projectDir = await makeProjectDir();

      // Generate Zig source with many syntax errors so ast-check emits a
      // long diagnostic. Each `const z_<n> = ;` is its own error line.
      const errorLines = Array.from(
        { length: 200 },
        (_, i) => `const z_${i} = ;\n`,
      ).join("");
      // Wrap in a container struct so the parser walks all lines.
      const invalidZig = `const S = struct {\n${errorLines}};\n`;

      const payload = {
        tool_name: "Write",
        tool_input: {
          file_path: "/workspace/many-errors.zig",
          content: invalidZig,
        },
      };
      const { parsed, exitCode } = await runHook(payload, projectDir);
      expect(exitCode).toBe(0);

      const out = parsed as {
        hookSpecificOutput?: {
          permissionDecision?: string;
          permissionDecisionReason?: string;
        };
      };
      expect(out?.hookSpecificOutput?.permissionDecision).toBe("deny");

      const reason = out?.hookSpecificOutput?.permissionDecisionReason ?? "";
      // The tail() helper in runtime.ts caps at 1500 chars; the reason string
      // also includes the preamble "zig ast-check failed on proposed edit to
      // /workspace/many-errors.zig:\n" (~60 chars). Allow a small margin.
      expect(reason.length).toBeLessThanOrEqual(1600);
      // It must still mention the file so the agent knows where to look.
      expect(reason).toContain("/workspace/many-errors.zig");
    },
    20_000,
  );
});
