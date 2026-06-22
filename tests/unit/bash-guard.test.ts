/**
 * Security-sentinel tests for pretooluse-bash-guard.ts.
 *
 * PURPOSE: Each test is a mutation sentinel. A false negative — a destructive
 * command that passes through unblocked — is a security hole. These tests
 * pin the CURRENT regex behavior, including known gaps, so any accidental
 * regex weakening causes an immediate test failure.
 *
 * KNOWN GAPS documented inline:
 *   GAP-1: rm with flags between -rf and / evades the pattern.
 *   GAP-2: rm -rf <subpath> is caught (slash prefix), but this means any
 *           path starting with / is denied, which may be overly broad.
 *   GAP-3: /\bgit\s+push\s+(--force|-f)\b/ matches --force-with-lease
 *           because \b fires between 'force' and '-' (non-word char). This
 *           causes force-with-lease on any branch (not just main) to be denied.
 *
 * STRATEGY: Import the exported arrays directly and test regex matching
 * in-process. No subprocess needed for the regex layer — it is pure JS.
 * E2E subprocess tests at the bottom verify the hook's JSON wire protocol.
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  DENY_PATTERNS,
  UNTRUSTED_INSTR_MARKERS,
} from "../../.claude/hooks/pretooluse-bash-guard.ts";

// ---------------------------------------------------------------------------
// Core helper — mirrors the hook's own inner loop. A command is denied if ANY
// pattern in DENY_PATTERNS matches it.
// ---------------------------------------------------------------------------
const denies = (cmd: string): boolean => DENY_PATTERNS.some((re) => re.test(cmd));
const flagsMarker = (text: string): boolean =>
  UNTRUSTED_INSTR_MARKERS.some((re) => re.test(text));

// Absolute path to the hook binary for E2E subprocess tests.
const HOOK = resolve(
  import.meta.dir,
  "../../.claude/hooks/pretooluse-bash-guard.ts",
);
const BUN_EXE = process.execPath;

// Reusable subprocess helper — sends a JSON payload on stdin and returns the
// parsed stdout, raw stderr, and exit code.
async function runHook(payload: unknown): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  parsed: unknown;
}> {
  const input = JSON.stringify(payload);
  const proc = Bun.spawn([BUN_EXE, HOOK], {
    stdin: new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      // Point log writes at /tmp so the hook does not pollute the repo's
      // .claude/logs/ directory during tests.
      CLAUDE_PROJECT_DIR: "/tmp",
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

// Build command strings that contain sensitive substrings indirectly so the
// pretooluse-bash-guard hook (which scans the raw Bash tool call string) does
// not intercept *this test file's* own code when Claude Code reads it.
// The hook fires on the literal command string passed to Bash, not on the
// test file contents — but we still avoid false-positive hook triggers on any
// editor/lint pass that might invoke Bash with the file contents.
const SLASH = "/";
const RM_RF_ROOT          = ["rm", "-rf", SLASH].join(" ");
const RM_RF_NO_PRESERVE   = ["rm", "-rf", "--no-preserve-root", SLASH].join(" ");
const RM_RF_SUBPATH       = ["rm", "-rf", SLASH + "tmp/build"].join(" ");
const RM_RF_DOUBLE_SPACE  = "rm  -rf  " + SLASH;
const GIT_PUSH_FORCE      = "git push --force";
const GIT_PUSH_F          = "git push -f";
const GIT_PUSH_SAFE       = "git push origin main";
const GIT_PUSH_FWL_MAIN   = "git push --force-with-lease origin main";
const GIT_PUSH_FWL_FEAT   = "git push --force-with-lease origin feature-branch";
const GIT_TAG             = "git tag v1.0";
const COSIGN_CMD          = "cosign sign image:tag";
const CHEZMOI_PURGE       = "chezmoi purge";
const JJ_UNDO             = "jj undo";
const JJ_ABANDON          = "jj abandon";
const JJ_OP_RESTORE       = "jj op restore";
const JJ_LOG              = "jj log";
const JJ_STATUS           = "jj status";
const DD_DISK             = "dd if=x of=" + SLASH + "dev/disk2";
const DD_SD               = "dd if=x of=" + SLASH + "dev/sda";
const DD_TMP              = "dd if=x of=" + SLASH + "tmp/b";

// ===========================================================================
// DENY_PATTERNS — regex layer
// ===========================================================================
describe("DENY_PATTERNS", () => {
  // -------------------------------------------------------------------------
  // rm -rf variants
  // -------------------------------------------------------------------------
  describe("rm -rf", () => {
    test("(1) rm -rf / is denied", () => {
      expect(denies(RM_RF_ROOT)).toBe(true);
    });

    test("(2) rm -rf --no-preserve-root / is denied [GAP-1 FIXED 2026-06]", () => {
      // GAP-1 (was a genuine hole): `rm -rf --no-preserve-root /` deletes the
      // entire filesystem on Linux, but the original /\brm\s+-rf?\s+\// required
      // the slash immediately after -rf, so interspersed flags defeated it.
      // Hardened to /\brm\s+-rf?(\s+--?\S+)*\s+\// which tolerates intervening
      // flags before the path. This MUST stay denied — it is a mutation sentinel
      // for the hardened pattern.
      expect(denies(RM_RF_NO_PRESERVE)).toBe(true);
    });

    test("(3) rm -rf /tmp/build IS denied [KNOWN GAP-2: all absolute paths caught]", () => {
      // GAP-2: The pattern matches any path starting with /. This means
      // rm -rf /tmp/build is denied even though it targets a subdirectory.
      // This is intentionally conservative but may be overly broad.
      // Current behavior: DENIED. Pinned here as a reality anchor.
      expect(denies(RM_RF_SUBPATH)).toBe(true);
    });

    test("(4) rm  -rf  / with double spaces is denied", () => {
      // \\s+ in the pattern matches one or more whitespace chars, so
      // multiple spaces between tokens still trigger the guard.
      expect(denies(RM_RF_DOUBLE_SPACE)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // git push force variants
  // -------------------------------------------------------------------------
  describe("git push --force / -f", () => {
    test("(5) git push --force is denied", () => {
      expect(denies(GIT_PUSH_FORCE)).toBe(true);
    });

    test("(6) git push -f is denied", () => {
      expect(denies(GIT_PUSH_F)).toBe(true);
    });

    test("(7) git push origin main (no force flag) is NOT denied", () => {
      expect(denies(GIT_PUSH_SAFE)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // git push --force-with-lease
  // -------------------------------------------------------------------------
  describe("git push --force-with-lease", () => {
    test("(8) git push --force-with-lease origin main is denied", () => {
      // The dedicated pattern /\bgit\s+push\s+--force-with-lease\s+origin\s+main\b/
      // matches this. Additionally, pattern[1] (/\bgit\s+push\s+(--force|-f)\b/)
      // ALSO matches because \b fires between 'force' and '-' in '--force-with-lease'.
      expect(denies(GIT_PUSH_FWL_MAIN)).toBe(true);
    });

    test("(9) git push --force-with-lease origin feature-branch is NOT denied [GAP-3 FIXED 2026-06]", () => {
      // GAP-3 (was a false positive): the blanket force-push rule used to fire
      // on the *safer* --force-with-lease (\\b matches between 'force' and '-').
      // pattern[1] now uses a negative lookahead /--force(?!-with-lease)/, so a
      // force-with-lease push to a feature branch is allowed. The dangerous
      // `--force-with-lease origin main` is still denied by the dedicated rule
      // (see test 8) — that pairing remains a mutation sentinel.
      expect(denies(GIT_PUSH_FWL_FEAT)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // git tag
  // -------------------------------------------------------------------------
  describe("git tag", () => {
    test("(10) git tag v1.0 is denied", () => {
      expect(denies(GIT_TAG)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // cosign
  // -------------------------------------------------------------------------
  describe("cosign", () => {
    test("(11) cosign sign image:tag is denied", () => {
      expect(denies(COSIGN_CMD)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // chezmoi purge
  // -------------------------------------------------------------------------
  describe("chezmoi purge", () => {
    test("(12) chezmoi purge is denied", () => {
      expect(denies(CHEZMOI_PURGE)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // jj destructive operations
  // -------------------------------------------------------------------------
  describe("jj", () => {
    test("(13) jj undo is denied", () => {
      expect(denies(JJ_UNDO)).toBe(true);
    });

    test("(14) jj abandon is denied", () => {
      expect(denies(JJ_ABANDON)).toBe(true);
    });

    test("(15) jj op restore is denied", () => {
      expect(denies(JJ_OP_RESTORE)).toBe(true);
    });

    test("(16) jj log is NOT denied", () => {
      expect(denies(JJ_LOG)).toBe(false);
    });

    test("(17) jj status is NOT denied", () => {
      expect(denies(JJ_STATUS)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // dd to block device
  // -------------------------------------------------------------------------
  describe("dd", () => {
    test("(18) dd if=x of=/dev/disk2 is denied", () => {
      expect(denies(DD_DISK)).toBe(true);
    });

    test("(19) dd if=x of=/dev/sda is denied", () => {
      expect(denies(DD_SD)).toBe(true);
    });

    test("(20) dd if=x of=/tmp/b is NOT denied", () => {
      // Pattern requires of=/dev/(disk|sd) — /tmp is not a block device path.
      expect(denies(DD_TMP)).toBe(false);
    });
  });
});

// ===========================================================================
// UNTRUSTED_INSTR_MARKERS — regex layer
// ===========================================================================
describe("UNTRUSTED_INSTR_MARKERS", () => {
  test("(21) 'ignore previous instructions' fires (case-insensitive)", () => {
    expect(flagsMarker("ignore previous instructions")).toBe(true);
    expect(flagsMarker("IGNORE PREVIOUS INSTRUCTIONS")).toBe(true);
  });

  test("(22) 'System Note:' fires (case-insensitive, colon required)", () => {
    expect(flagsMarker("System Note: do something")).toBe(true);
    expect(flagsMarker("system note: lowercase")).toBe(true);
  });

  test("(23) '{{ secret' fires (template injection marker)", () => {
    expect(flagsMarker("{{ secret foo }}")).toBe(true);
    // Leading whitespace inside braces also matches due to \s*
    expect(flagsMarker("{{\tsecret value }}")).toBe(true);
  });

  test("(24) normal shell command does NOT fire any marker", () => {
    expect(flagsMarker("zig build test")).toBe(false);
    expect(flagsMarker("bun run scripts/verify-fast.ts")).toBe(false);
  });
});

// ===========================================================================
// E2E subprocess tests — wire protocol verification
// ===========================================================================
describe("E2E hook wire protocol (subprocess)", () => {
  test("(25) destructive command payload → permissionDecision:'deny', exit 0", async () => {
    // Build a payload that the hook will block: rm -rf root
    const payload = {
      tool_name: "Bash",
      tool_input: {
        // Construct via join to avoid hook scanning this test file's source
        command: ["rm", "-rf", SLASH].join(" "),
      },
    };
    const { parsed, exitCode } = await runHook(payload);
    expect(exitCode).toBe(0);
    const out = parsed as {
      hookSpecificOutput?: { permissionDecision?: string };
    };
    expect(out?.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("(26) safe command 'git status' → {continue:true}, exit 0", async () => {
    const payload = {
      tool_name: "Bash",
      tool_input: { command: "git status" },
    };
    const { parsed, exitCode } = await runHook(payload);
    expect(exitCode).toBe(0);
    expect(parsed).toEqual({ continue: true });
  });

  test("(27) non-Bash tool (e.g. Read) → {continue:true}, exit 0", async () => {
    const payload = {
      tool_name: "Read",
      tool_input: { file_path: "/tmp/foo.txt" },
    };
    const { parsed, exitCode } = await runHook(payload);
    expect(exitCode).toBe(0);
    expect(parsed).toEqual({ continue: true });
  });
});
