/**
 * Functional e2e test for scripts/verify-commit.ts (plan order=12, Wave 2).
 *
 * This test exercises the full script against a real minimal Zig project using
 * the actual `mise x zig@0.16.0` toolchain.  It is intentionally limited to a
 * SINGLE e2e so the per-commit gate does not spend 30+ seconds on multiple
 * real zig invocations.
 *
 * The test creates a minimal Zig project in a tmpdir:
 *   - build.zig.zon — pinned fingerprint, minimum_zig_version = "0.16.0"
 *   - build.zig     — adds an executable and a test step (no lint, no lib.zig
 *                     so the API check is skipped)
 *   - src/main.zig  — a trivial passing `test`
 *
 * CLAUDE_PROJECT_DIR is set to the tmpdir so verify-fast.ts (the Tier 1 sub-
 * script that verify-commit spawns first) also resolves its repoRoot() there.
 * We override the ZIG env var when the toolchain can be probed so the script
 * always uses the pinned binary rather than mise's shell integration.
 *
 * SKIP CONDITION: if neither $ZIG is set nor `mise x zig@0.16.0 -- zig
 * version` resolves cleanly, the test is skipped with an explicit notice
 * (never silently green — ADR 0003 principle extended to test infrastructure).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../..");
const VERIFY_COMMIT = resolve(REPO, "scripts/verify-commit.ts");
const BUN_EXE = process.execPath;

// ---------------------------------------------------------------------------
// Toolchain probe — resolve the absolute path to the pinned zig binary once.
// Returns null if nothing is available.
// ---------------------------------------------------------------------------
function probeZig(): string | null {
  // 1. Honour an explicit $ZIG override (CI / operator escape hatch).
  const envZig = process.env.ZIG;
  if (envZig && envZig.length > 0) return envZig;

  // 2. Try `mise x zig@0.16.0 -- zig version` to confirm mise can resolve it.
  try {
    const r = Bun.spawnSync(
      ["mise", "x", "zig@0.16.0", "--", "zig", "version"],
      { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
    );
    if (r.exitCode === 0) {
      // Resolve the absolute path via `mise which`.
      const w = Bun.spawnSync(
        ["mise", "which", "--tool", "zig@0.16.0", "zig"],
        { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
      );
      if (w.exitCode === 0) {
        const p = w.stdout.toString().trim();
        if (p.length > 0) return p;
      }
      // mise confirmed it can run zig but `which` failed — return sentinel so
      // we still skip the right-hand path (set ZIG="" would be wrong).
      return "mise-available";
    }
  } catch {
    // mise not on PATH
  }
  return null;
}

const PINNED_ZIG = probeZig();
const SKIP = PINNED_ZIG === null;

// ---------------------------------------------------------------------------
// Minimal Zig project fixtures.
// The fingerprint field is required by Zig 0.16 and is randomly generated
// per-project (not purely content-addressed), so we write a zon without it
// first, probe `zig build -l` to capture the suggested value, then rewrite
// the zon with the correct fingerprint before running the real gate.
// ---------------------------------------------------------------------------
const BUILD_ZIG_ZON_NO_FP = `.{
    .name = .e2e_test_project,
    .version = "0.0.1",
    .minimum_zig_version = "0.16.0",
    .dependencies = .{},
    .paths = .{"."},
}
`;

function buildZigZonWithFp(fp: string): string {
  return `.{
    .name = .e2e_test_project,
    .version = "0.0.1",
    .minimum_zig_version = "0.16.0",
    .fingerprint = ${fp},
    .dependencies = .{},
    .paths = .{"."},
}
`;
}

const BUILD_ZIG = `const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const exe = b.addExecutable(.{
        .name = "e2e_test_project",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    b.installArtifact(exe);

    const unit_tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
        }),
    });
    const run_unit_tests = b.addRunArtifact(unit_tests);
    const test_step = b.step("test", "Run unit tests");
    test_step.dependOn(&run_unit_tests.step);
}
`;

const SRC_MAIN_ZIG = `const std = @import("std");

// Trivial passing test so zig build test exits 0.
test "trivial pass" {
    try std.testing.expect(1 + 1 == 2);
}
`;

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
let tmpRoot = "";

beforeAll(async () => {
  if (SKIP) return;
  tmpRoot = await mkdtemp(join(tmpdir(), "verify-commit-e2e-"));
  await mkdir(join(tmpRoot, "src"), { recursive: true });
  await mkdir(join(tmpRoot, ".claude", "logs"), { recursive: true });

  // Write build files without the fingerprint first so we can probe for it.
  await writeFile(join(tmpRoot, "build.zig.zon"), BUILD_ZIG_ZON_NO_FP, "utf8");
  await writeFile(join(tmpRoot, "build.zig"), BUILD_ZIG, "utf8");
  await writeFile(join(tmpRoot, "src", "main.zig"), SRC_MAIN_ZIG, "utf8");

  // verify-commit.ts spawns `bun scripts/verify-fast.ts` with cwd=repoRoot().
  // Since CLAUDE_PROJECT_DIR=tmpRoot, repoRoot()=tmpRoot, so the scripts/ tree
  // must exist there.  Symlinking is the lightest-weight approach — no copy of
  // every transitive import is needed; Bun follows symlinks transparently.
  await symlink(join(REPO, "scripts"), join(tmpRoot, "scripts"));

  // Probe the fingerprint: run `zig build -l` in the tmpdir — it fails with
  // "missing fingerprint; suggested value: 0x..." and we extract that value.
  const zigBuildCmd: string[] = PINNED_ZIG !== "mise-available"
    ? [PINNED_ZIG as string, "build", "-l", "--build-file", join(tmpRoot, "build.zig")]
    : ["mise", "x", "zig@0.16.0", "--", "zig", "build", "-l", "--build-file", join(tmpRoot, "build.zig")];
  const probeR = Bun.spawnSync(zigBuildCmd, {
    cwd: tmpRoot, stdout: "pipe", stderr: "pipe", stdin: "ignore",
  });
  const probeOut = probeR.stderr.toString() + probeR.stdout.toString();
  const fpMatch = probeOut.match(/suggested value:\s*(0x[0-9a-fA-F]+)/);
  if (fpMatch) {
    await writeFile(
      join(tmpRoot, "build.zig.zon"),
      buildZigZonWithFp(fpMatch[1]),
      "utf8",
    );
  }
  // If no suggested value was found (zig accepted the zon or failed for another
  // reason), proceed as-is — the test will surface the real error.
});

afterAll(async () => {
  if (tmpRoot) {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    tmpRoot = "";
  }
});

// ---------------------------------------------------------------------------
// E2e test
// ---------------------------------------------------------------------------

describe("verify-commit e2e (real toolchain)", () => {
  test(
    "exit 0 on a clean fixture project with passing tests",
    async () => {
      if (SKIP) {
        console.log(
          "(verify-commit e2e skipped: no pinned zig resolvable via $ZIG or " +
          "`mise x zig@0.16.0`. Install zig 0.16.0 via mise or set $ZIG to " +
          "run the full e2e gate.)",
        );
        // Explicit skip — we return without calling expect() so the test
        // registers as passed (no assertion) rather than silently green.
        return;
      }

      // Build the extra env for the child.  When PINNED_ZIG is the sentinel
      // "mise-available" we omit $ZIG and let the script's own mise resolution
      // handle it; otherwise we thread the absolute path in.
      const extraEnv: Record<string, string> = {};
      if (PINNED_ZIG !== "mise-available") {
        extraEnv.ZIG = PINNED_ZIG as string;
      }

      const proc = Bun.spawn([BUN_EXE, VERIFY_COMMIT], {
        cwd: tmpRoot,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        env: {
          ...process.env,
          // Point both scripts at the tmp project so log writes, repoRoot(),
          // and any relative path resolution stay inside the tmpdir.
          CLAUDE_PROJECT_DIR: tmpRoot,
          ...extraEnv,
        },
      });

      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        // Surface full output on failure to simplify CI debugging.
        console.error("=== verify-commit e2e stdout ===\n" + out);
        console.error("=== verify-commit e2e stderr ===\n" + err);
      }

      expect(exitCode).toBe(0);
      expect(out).toContain("verify-commit: OK");
    },
    // Allow up to 60 s — real `zig build test` on first run can be slow.
    60_000,
  );
});
