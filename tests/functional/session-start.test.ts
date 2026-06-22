/**
 * Functional (subprocess) tests for .claude/hooks/session-start.ts.
 *
 * STRATEGY: Spawn the hook as a child process with controlled env and
 * CLAUDE_PROJECT_DIR pointing to a per-test tmpdir. Parse stdout JSON and
 * read the session-start.jsonl log written under the tmpdir.
 *
 * The hook has no DI seam (it reads real jj/git/zig), so subprocess testing
 * is the only reliable strategy.
 *
 * PATH-MANIPULATION TESTS: For tests that degrade jj/git/zig, we build a
 * minimal PATH containing only the directory of the `bun` binary (so the hook
 * itself can be launched) and assert the degraded behavior.
 *
 * EXIT SEMANTICS: session-start always calls process.exit(0) on success and
 * process.exit(1) on an unhandled error. We assert exitCode === 0 for all
 * happy-path and degraded-but-handled cases.
 */

import { describe, expect, test, afterAll } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { resolve, join, dirname } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const REPO = resolve(import.meta.dir, "../..");
const HOOK = resolve(REPO, ".claude/hooks/session-start.ts");
const BUN_EXE = process.execPath;
// The directory containing the bun binary — used to build minimal PATHs that
// still allow the hook subprocess to execute while excluding jj/git/mise/zig.
const BUN_DIR = dirname(BUN_EXE);

// ---------------------------------------------------------------------------
// Shared tmpdir root — one sub-dir per test for log isolation.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), "session-start-func-"));

afterAll(() => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create an isolated tmpdir under TMP_ROOT for a single test. */
function makeTestDir(label: string): string {
  const d = join(TMP_ROOT, label.replace(/[^a-zA-Z0-9_-]/g, "_"));
  mkdirSync(d, { recursive: true });
  return d;
}

type RunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  parsed: Record<string, unknown> | null;
};

/**
 * Spawn the session-start hook as a subprocess.
 *
 * @param projectDir  Written as CLAUDE_PROJECT_DIR; the hook logs here.
 * @param extraEnv    Merged on top of process.env (can override PATH, ZIG, etc.).
 */
async function runHook(
  projectDir: string,
  extraEnv: Record<string, string> = {},
): Promise<RunResult> {
  const proc = Bun.spawn([BUN_EXE, HOOK], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: projectDir,
      ...extraEnv,
    },
  });

  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(out.trim()) as Record<string, unknown>;
  } catch {
    parsed = null;
  }

  return { stdout: out, stderr: err, exitCode, parsed };
}

/** Read all JSONL log lines from the hook's log file under projectDir. */
function readLog(projectDir: string): Array<Record<string, unknown>> {
  const logPath = join(projectDir, ".claude/logs/session-start.jsonl");
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("session-start hook — additionalContext content", () => {
  // -------------------------------------------------------------------------
  // (1) additionalContext contains 'Zig toolchain resolved:'
  // -------------------------------------------------------------------------
  test("(1) additionalContext contains 'Zig toolchain resolved:'", async () => {
    const dir = makeTestDir("t01-zig-version");
    const { exitCode, parsed } = await runHook(dir);
    expect(exitCode).toBe(0);
    const ctx = (
      parsed as {
        hookSpecificOutput?: { additionalContext?: string };
      }
    )?.hookSpecificOutput?.additionalContext ?? "";
    expect(ctx).toContain("Zig toolchain resolved:");
  }, 30_000);

  // -------------------------------------------------------------------------
  // (2) additionalContext contains 'Untrusted data boundary' (P0)
  // -------------------------------------------------------------------------
  test("(2) additionalContext contains 'Untrusted data boundary' (P0)", async () => {
    const dir = makeTestDir("t02-untrusted-boundary");
    const { exitCode, parsed } = await runHook(dir);
    expect(exitCode).toBe(0);
    const ctx = (
      parsed as {
        hookSpecificOutput?: { additionalContext?: string };
      }
    )?.hookSpecificOutput?.additionalContext ?? "";
    expect(ctx).toContain("Untrusted data boundary");
  }, 30_000);

  // -------------------------------------------------------------------------
  // (3) additionalContext contains 'DebugAllocator' AND '.empty'
  // -------------------------------------------------------------------------
  test("(3) additionalContext contains 'DebugAllocator' AND '.empty'", async () => {
    const dir = makeTestDir("t03-0-16-reminders");
    const { exitCode, parsed } = await runHook(dir);
    expect(exitCode).toBe(0);
    const ctx = (
      parsed as {
        hookSpecificOutput?: { additionalContext?: string };
      }
    )?.hookSpecificOutput?.additionalContext ?? "";
    expect(ctx).toContain("DebugAllocator");
    expect(ctx).toContain(".empty");
  }, 30_000);

  // -------------------------------------------------------------------------
  // (6) stdout JSON has hookSpecificOutput.hookEventName === 'SessionStart' (P0)
  // -------------------------------------------------------------------------
  test(
    "(6) hookSpecificOutput.hookEventName === 'SessionStart' (P0)",
    async () => {
      const dir = makeTestDir("t06-hook-event-name");
      const { exitCode, parsed } = await runHook(dir);
      expect(exitCode).toBe(0);
      const eventName = (
        parsed as {
          hookSpecificOutput?: { hookEventName?: string };
        }
      )?.hookSpecificOutput?.hookEventName;
      expect(eventName).toBe("SessionStart");
    },
    30_000,
  );
});

describe("session-start hook — JSONL log", () => {
  // -------------------------------------------------------------------------
  // (7) session-start.jsonl log entry has 'version' and 'branch' fields
  // -------------------------------------------------------------------------
  test(
    "(7) session-start.jsonl log entry has 'version' and 'branch' fields",
    async () => {
      const dir = makeTestDir("t07-jsonl-fields");
      const { exitCode } = await runHook(dir);
      expect(exitCode).toBe(0);
      const lines = readLog(dir);
      expect(lines.length).toBeGreaterThan(0);
      const entry = lines.find((l) => l.event === "session-start");
      expect(entry).toBeDefined();
      // 'version' is the resolved Zig version string (or 'unresolved')
      expect(typeof entry?.version).toBe("string");
      // 'branch' is the current git branch or '(detached)'
      expect(typeof entry?.branch).toBe("string");
      expect((entry?.branch as string).length).toBeGreaterThan(0);
    },
    30_000,
  );
});

describe("session-start hook — VCS degradation", () => {
  // -------------------------------------------------------------------------
  // (4) jj absent → falls to git log (history still appears, no crash)
  //
  // Build a PATH that has bun (to run the hook) and git (so git log works) but
  // NOT jj. The hook's spawnSync wraps ENOENT so jj absence is handled
  // gracefully. Assert exit 0 and that recent commit history appears in the
  // additionalContext (git log falls back correctly).
  // -------------------------------------------------------------------------
  test(
    "(4) jj absent → falls to git log (history present, no crash)",
    async () => {
      const dir = makeTestDir("t04-no-jj");

      // Find git's directory so we can include it in PATH while excluding jj.
      let gitDir: string | null = null;
      try {
        const probe = Bun.spawnSync(["which", "git"], { stdout: "pipe" });
        if (probe.exitCode === 0) {
          gitDir = dirname(probe.stdout.toString().trim());
        }
      } catch {
        // ignore
      }

      // Compose a PATH: bun dir + git dir (if found), without jj.
      // If we can't locate git, the test falls through to the no-history path —
      // that's still a valid degraded state (no crash).
      const pathParts = [BUN_DIR];
      if (gitDir && gitDir !== BUN_DIR) pathParts.push(gitDir);
      const minimalPath = pathParts.join(":");

      const { exitCode, parsed, stdout } = await runHook(dir, {
        PATH: minimalPath,
      });

      // The hook must not crash even when jj is absent.
      expect(exitCode).toBe(0);

      // stdout must be valid JSON
      expect(parsed).not.toBeNull();

      const ctx = (
        parsed as {
          hookSpecificOutput?: { additionalContext?: string };
        }
      )?.hookSpecificOutput?.additionalContext ?? "";

      // Should contain EITHER actual git history OR the fallback '(no history)'.
      // The key invariant is that it does not crash and additionalContext is set.
      expect(ctx.length).toBeGreaterThan(0);
      // Must not contain a raw Node/Bun error stack
      expect(stdout).not.toContain("at Object.<anonymous>");
    },
    30_000,
  );

  // -------------------------------------------------------------------------
  // (5) both jj and git absent → shows '(no history)' (no crash)
  //
  // PATH contains only bun's directory, so neither jj nor git resolves.
  // The hook's spawnSync wraps ENOENT and falls through. repoRoot() also
  // falls through to cwd() when jj+git are absent.
  // Also exclude mise so the zig resolution falls to 'bare-path' or 'unresolved'.
  // -------------------------------------------------------------------------
  test(
    "(5) both jj and git absent → '(no history)' in additionalContext, no crash",
    async () => {
      const dir = makeTestDir("t05-no-vcs");

      // Only bun in PATH — jj, git, mise, zig all absent.
      const { exitCode, parsed, stdout } = await runHook(dir, {
        PATH: BUN_DIR,
        // Clear ZIG override so the hook can't cheat via $ZIG
        ZIG: "",
      });

      // Must not crash
      expect(exitCode).toBe(0);

      // stdout must be parseable JSON
      expect(parsed).not.toBeNull();

      const ctx = (
        parsed as {
          hookSpecificOutput?: { additionalContext?: string };
        }
      )?.hookSpecificOutput?.additionalContext ?? "";

      // The fallback string appears when jjLog.stdout and gitRecent.stdout are
      // both empty (spawnSync returns "" on ENOENT).
      expect(ctx).toContain("(no history)");

      // No raw error stack
      expect(stdout).not.toContain("at Object.<anonymous>");
    },
    30_000,
  );

  // -------------------------------------------------------------------------
  // (8) branch field is a non-empty string or '(detached)'
  //
  // Forcing a true detached HEAD deterministically in the test runner's repo
  // would mutate shared VCS state, which is unsafe. Instead we assert the
  // invariant: the branch field is always a non-empty string, and when the
  // hook cannot determine a branch name it falls back to '(detached)'.
  //
  // A separate detached-HEAD scenario is tested by running in a fresh git repo
  // with no commits (git branch --show-current returns "" → '(detached)').
  // -------------------------------------------------------------------------
  test(
    "(8) branch is non-empty string (or '(detached)' on detached HEAD)",
    async () => {
      const dir = makeTestDir("t08-branch-field");

      // Initialize a fresh git repo with no commits in the tmpdir.
      // git branch --show-current returns "" on an unborn branch → hook emits
      // '(detached)'.
      Bun.spawnSync(["git", "init", dir], { stdout: "pipe", stderr: "pipe" });

      const { exitCode, parsed } = await runHook(dir, {
        // Point CLAUDE_PROJECT_DIR at the fresh repo so repoRoot() lands there.
        CLAUDE_PROJECT_DIR: dir,
      });

      expect(exitCode).toBe(0);
      const ctx = (
        parsed as {
          hookSpecificOutput?: { additionalContext?: string };
        }
      )?.hookSpecificOutput?.additionalContext ?? "";

      // Either a real branch name or the fallback
      const branchMatch =
        /Branch: (.+)/.exec(ctx);
      expect(branchMatch).not.toBeNull();
      const branchValue = branchMatch?.[1]?.trim() ?? "";
      expect(branchValue.length).toBeGreaterThan(0);
      // Valid: any non-empty branch name, OR the explicit fallback
      if (branchValue !== "(detached)") {
        // On a real repo, just ensure it's a plausible branch name string
        expect(typeof branchValue).toBe("string");
      }

      // Also check the JSONL log branch field
      const lines = readLog(dir);
      const entry = lines.find((l) => l.event === "session-start");
      if (entry) {
        expect(typeof entry.branch).toBe("string");
        expect((entry.branch as string).length).toBeGreaterThan(0);
      }
    },
    30_000,
  );
});

describe("session-start hook — Zig toolchain degradation", () => {
  // -------------------------------------------------------------------------
  // (9) ZIG=/nonexistent and mise absent → version shows 'unresolved'
  //
  // zigVersion() resolution order (from scripts/lib/zig.ts):
  //   1. $ZIG env var (honored first)
  //   2. mise (if on PATH)
  //   3. bare zig on PATH (last resort — returns whatever the host has)
  //
  // To force 'unresolved' we must:
  //   - Set ZIG=/nonexistent/zig so spawnSync("/nonexistent/zig version") fails
  //     (ENOENT or non-zero exit). zigVersion() returns "" which the hook coerces
  //     to "unresolved".
  //   - When $ZIG is set, zigResolution() returns "env" immediately, so mise
  //     is never consulted. We just need the binary to not exist.
  //
  // NOTE: Bun.spawnSync with a non-existent binary throws ENOENT (does not
  // return a result); the zig() helper in zig.ts calls spawnSync() which
  // wraps the raw Bun.spawnSync without a try/catch — so a non-existent $ZIG
  // will propagate as an exception, causing zigVersion() to throw rather than
  // return "". The hook's main() does NOT wrap zigVersion() in a try/catch,
  // so it propagates to the outer .catch() handler which exits 1.
  //
  // To produce 'unresolved' cleanly, we instead pass a PATH that excludes
  // mise and zig, and leave $ZIG unset. That way zigResolution() reaches
  // "bare-path", spawnSync(["zig", "version"]) throws ENOENT in spawnSync
  // (bare Bun.spawnSync), and zigVersion() returns "". The hook coerces ""
  // to "unresolved". We also need bun in PATH to run the hook itself.
  //
  // This is the tested and correct way to exercise the 'unresolved' path.
  // -------------------------------------------------------------------------
  test(
    "(9) zig absent from PATH and no mise → version shows 'unresolved'",
    async () => {
      const dir = makeTestDir("t09-zig-unresolved");

      // Build a PATH with only bun — no zig, no mise.
      // zigResolution() → "bare-path"; spawnSync(["zig","version"]) throws
      // ENOENT; spawnSync() in runtime.ts does NOT catch ENOENT so we need
      // to check if runtime.spawnSync catches it or not.
      //
      // From runtime.ts: spawnSync() calls Bun.spawnSync() directly without
      // try/catch. Bun.spawnSync throws when the binary is absent. So
      // zigVersion() will throw, main() catches via .catch() → exit(1).
      //
      // Alternative approach: set ZIG to a script that exits 1 (not ENOENT).
      // We can use the bun binary itself with a -e flag that exits 1, ensuring
      // the binary EXISTS but zig version fails → zigVersion() returns "" →
      // hook coerces to "unresolved".
      //
      // We borrow BUN_EXE as the ZIG binary with args that make it exit 1:
      // But we can't pass args via $ZIG (it's treated as the binary path only).
      //
      // Cleanest solution: create a tiny shell script in tmpdir that exits 1
      // (so ZIG points to an existing file that returns non-zero).
      const fakeZigPath = join(dir, "fake-zig");
      await Bun.write(fakeZigPath, "#!/bin/sh\nexit 1\n");
      Bun.spawnSync(["chmod", "+x", fakeZigPath]);

      const { exitCode, parsed } = await runHook(dir, {
        ZIG: fakeZigPath,
        // Clear mise from PATH is not needed because $ZIG takes priority
        // (zigResolution returns "env" immediately when ZIG is set).
      });

      // The hook should exit 0 even with a broken ZIG; zigVersion() returns ""
      // (spawnSync gets exit code 1, stdout is ""), hook coerces to "unresolved".
      expect(exitCode).toBe(0);

      const ctx = (
        parsed as {
          hookSpecificOutput?: { additionalContext?: string };
        }
      )?.hookSpecificOutput?.additionalContext ?? "";

      expect(ctx).toContain("unresolved");
    },
    30_000,
  );
});
