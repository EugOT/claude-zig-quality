/**
 * E2E test: verify-release.ts exits 0 on a minimal fixture repo.
 *
 * Strategy:
 *   - Build a minimal Zig project in a tmpdir: build.zig + build.zig.zon +
 *     src/main.zig that produces a real zig-out/bin artifact.
 *   - Point CLAUDE_PROJECT_DIR at the tmpdir so repoRoot() returns it.
 *   - Unset COSIGN_ENABLED and CI → signing is skipped cleanly.
 *   - Intercept the verify-pr sub-call: verify-release spawns
 *     `bun scripts/verify-pr.ts` relative to the repo root, but with
 *     CLAUDE_PROJECT_DIR pointing at our tmpdir that has NO scripts/ dir,
 *     that call would fail. We stub it by prepending a fake `bun` on PATH
 *     that exits 0 immediately for verify-pr invocations and delegates
 *     everything else to the real bun. This is the cleanest seam available
 *     since verify-release.main() is not DI-able.
 *   - The SBOM step: scripts/emit-sbom.zig is absent in the fixture (it's
 *     repo-relative via the real root lookup) and syft is likely absent too,
 *     so it degrades to a loud skip — which is a pass.
 *   - verify-release runs TWO clean zig builds. Each takes ~10-30s on the
 *     CI box with a pre-warmed cache, possibly up to 60s cold. Timeout: 180s.
 *   - Assert: exit code 0 AND the JSONL log contains a verify/release entry.
 *
 * Skip condition: mise + zig@0.16.0 must be resolvable.
 *
 * NOTE: This test is intentionally slow. The 180000ms timeout is required
 * because two clean Zig builds run sequentially. Do not lower it.
 */

import { describe, expect, test } from "bun:test";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const VERIFY_RELEASE = resolve(
	import.meta.dir,
	"../../scripts/verify-release.ts",
);
const BUN_EXE = process.execPath;

// ---------------------------------------------------------------------------
// Skip guard: require mise + zig@0.16.0
// ---------------------------------------------------------------------------

function hasMiseZig(): boolean {
	if (Bun.which("mise") === null) return false;
	try {
		const r = Bun.spawnSync(
			["mise", "x", "zig@0.16.0", "--", "zig", "version"],
			{ stdout: "pipe", stderr: "pipe", stdin: "ignore" },
		);
		return r.exitCode === 0;
	} catch {
		return false;
	}
}

const TOOLCHAIN_AVAILABLE = hasMiseZig();

// ---------------------------------------------------------------------------
// Minimal fixture Zig project
//
// build.zig: produces zig-out/bin/hello from src/main.zig.
// No external dependencies → build.zig.zon is dependency-free.
// No fmt/lint/test complexity: the fixture just needs to build cleanly twice.
// ---------------------------------------------------------------------------

const FIXTURE_BUILD_ZIG = `\
const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const exe_mod = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
    });
    const exe = b.addExecutable(.{
        .name = "hello",
        .root_module = exe_mod,
    });
    b.installArtifact(exe);
}
`;

// build.zig.zon template: the fingerprint must match what Zig computes for this
// package path+name. Since the tmpdir path varies per run, we use a sentinel
// value and then fix it up via probeFingerprint() before the real builds.
const FIXTURE_BUILD_ZON_TEMPLATE = `\
.{
    .name = .hello_fixture,
    .version = "0.1.0",
    .fingerprint = 0x0000000000000001,
    .minimum_zig_version = "0.16.0",
    .paths = .{
        "build.zig",
        "build.zig.zon",
        "src",
    },
}
`;

/**
 * Run a probe `zig build` with the sentinel fingerprint, parse the error
 * message ("use this value: 0x..."), rewrite build.zig.zon with the correct
 * value, and return it for logging. Returns null if zig is not available.
 */
async function probeFingerprint(fixtureRoot: string): Promise<string | null> {
	const r = Bun.spawnSync(
		["mise", "x", "zig@0.16.0", "--", "zig", "build"],
		{
			cwd: fixtureRoot,
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
			env: { ...process.env, SOURCE_DATE_EPOCH: "1767225600" },
		},
	);
	if (r.exitCode === 0) return null; // already correct (shouldn't happen with sentinel)
	const combined = r.stderr.toString() + r.stdout.toString();
	const m = combined.match(/use this value:\s*(0x[0-9a-fA-F]+)/);
	if (!m) return null; // fingerprint not the issue, or zig absent
	const fp = m[1];
	const fixed = FIXTURE_BUILD_ZON_TEMPLATE.replace(
		"0x0000000000000001",
		fp,
	);
	await writeFile(join(fixtureRoot, "build.zig.zon"), fixed, "utf8");
	return fp;
}

// src/main.zig: minimal deterministic executable. Uses std.process.Init
// (Zig 0.16 "juicy main" pattern) so it compiles cleanly.
const FIXTURE_MAIN_ZIG = `\
const std = @import("std");

pub fn main(init: std.process.Init) !u8 {
    const io = init.io;
    var buf: [64]u8 = undefined;
    var w = std.Io.File.stdout().writerStreaming(io, &buf);
    try w.interface.writeAll("hello\\n");
    try w.flush();
    return 0;
}
`;

// ---------------------------------------------------------------------------
// Fake `bun` wrapper
//
// verify-release.ts spawns `bun scripts/verify-pr.ts` as its first sub-call.
// Since our fixture has no scripts/ dir, that would fail.  We place a fake
// `bun` shim at the front of PATH that:
//   - If invoked as `bun scripts/verify-pr.ts` → exits 0 (stubbed pass)
//   - Otherwise → delegates to the real bun executable
//
// This is the minimal invasive approach for a non-DI-able main().
// ---------------------------------------------------------------------------

function makeFakeBunScript(realBunPath: string): string {
	// The shim checks whether the first argument ends with verify-pr.ts.
	// If so, it exits 0 immediately (stubbed). Otherwise it exec's real bun.
	return `#!/bin/sh
case "$1" in
  *verify-pr.ts)
    # Stubbed: verify-pr passes in this fixture
    exit 0
    ;;
  *)
    exec "${realBunPath}" "$@"
    ;;
esac
`;
}

// ---------------------------------------------------------------------------
// Fake `git` for sourceDateEpoch()
//
// verify-release calls `git -C root log -1 --format=%ct` to get the epoch.
// In a tmpdir fixture there is no git repo, so git exits non-zero and the
// fallback epoch is used — that's fine. No stub needed.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helper: spawn verify-release.ts as a subprocess in the fixture dir.
// ---------------------------------------------------------------------------

interface RunResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

async function runVerifyRelease(
	fixtureRoot: string,
	fakeBunDir: string,
	extraEnv: Record<string, string | undefined> = {},
): Promise<RunResult> {
	// Build the child environment:
	//   - Strip COSIGN_ENABLED and CI so signing is skipped cleanly.
	//   - Prepend fakeBunDir so our stub bun intercepts verify-pr.
	//   - CLAUDE_PROJECT_DIR → fixtureRoot.
	//   - SOURCE_DATE_EPOCH pinned for reproducibility (avoids git lookup latency).
	const parentEnv: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (v !== undefined) parentEnv[k] = v;
	}
	// Remove signing-trigger vars.
	delete parentEnv.COSIGN_ENABLED;
	delete parentEnv.CI;

	const childEnv: Record<string, string> = {
		...parentEnv,
		CLAUDE_PROJECT_DIR: fixtureRoot,
		PATH: `${fakeBunDir}:${parentEnv.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
		SOURCE_DATE_EPOCH: "1767225600",
		...Object.fromEntries(
			Object.entries(extraEnv).filter(([, v]) => v !== undefined) as [
				string,
				string,
			][],
		),
	};

	const proc = Bun.spawn([BUN_EXE, VERIFY_RELEASE], {
		cwd: fixtureRoot,
		env: childEnv,
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

// ---------------------------------------------------------------------------
// E2E test
// ---------------------------------------------------------------------------

describe("verify-release e2e", () => {
	test(
		"exits 0 on a minimal reproducible Zig fixture with signing skipped",
		async () => {
			if (!TOOLCHAIN_AVAILABLE) {
				console.log(
					"(skipped: mise + zig@0.16.0 not available on this host)",
				);
				return;
			}

			// 1. Create the fixture project.
			const fixtureRoot = await mkdtemp(join(tmpdir(), "vr-e2e-fixture-"));
			const fakeBunDir = await mkdtemp(join(tmpdir(), "vr-e2e-fakebun-"));

			try {
				// Write the fixture Zig project.
				await mkdir(join(fixtureRoot, "src"), { recursive: true });
				await mkdir(join(fixtureRoot, ".claude", "logs"), { recursive: true });
				await writeFile(
					join(fixtureRoot, "build.zig"),
					FIXTURE_BUILD_ZIG,
					"utf8",
				);
				// Write the template first (sentinel fingerprint), then probe-fix it.
				await writeFile(
					join(fixtureRoot, "build.zig.zon"),
					FIXTURE_BUILD_ZON_TEMPLATE,
					"utf8",
				);
				await writeFile(
					join(fixtureRoot, "src", "main.zig"),
					FIXTURE_MAIN_ZIG,
					"utf8",
				);

				// Fix up the fingerprint: Zig 0.16 requires an exact content-addressed
				// fingerprint in build.zig.zon. The correct value depends on the
				// package path (which includes the tmpdir), so we do a probe build with
				// the sentinel value and rewrite the file with the value Zig suggests.
				const fp = await probeFingerprint(fixtureRoot);
				if (fp === null) {
					// If probeFingerprint returned null and we can't fix the fingerprint,
					// the sentinel was somehow already correct or zig is absent.
					// Check if zig is truly absent and skip.
					if (!TOOLCHAIN_AVAILABLE) {
						console.log("(skipped: zig toolchain unavailable for fingerprint probe)");
						return;
					}
					// Otherwise proceed — the sentinel may have worked.
				}

				// 2. Write the fake bun shim.
				const fakeBunPath = join(fakeBunDir, "bun");
				await writeFile(fakeBunPath, makeFakeBunScript(BUN_EXE), {
					mode: 0o755,
				});

				// 3. Run verify-release.ts.
				const { stdout, stderr, exitCode } = await runVerifyRelease(
					fixtureRoot,
					fakeBunDir,
				);

				// Diagnostics on failure.
				if (exitCode !== 0) {
					console.error("=== verify-release stdout ===");
					console.error(stdout);
					console.error("=== verify-release stderr ===");
					console.error(stderr);
				}

				// 4. Assert exit 0.
				expect(exitCode).toBe(0);

				// 5. Assert that the JSONL log got a verify/release entry.
				const logPath = join(fixtureRoot, ".claude", "logs", "verify.jsonl");
				const logExists = await Bun.file(logPath).exists();
				expect(logExists).toBe(true);

				const logText = await readFile(logPath, "utf8");
				const lines = logText
					.trim()
					.split("\n")
					.filter((l) => l.trim().length > 0);

				// At least one JSONL entry must be present.
				expect(lines.length).toBeGreaterThan(0);

				// The last entry should be the release-tier completion entry.
				const lastEntry = JSON.parse(lines[lines.length - 1]);
				expect(lastEntry.event).toBe("verify");
				expect(lastEntry.tier).toBe("release");
				expect(lastEntry.code).toBe(0);
				expect(typeof lastEntry.durationMs).toBe("number");

				// 6. Assert cosign signing was skipped (no .sig files anywhere).
				const sigGlob = new Bun.Glob("**/*.sig");
				const sigFiles: string[] = [];
				for (const f of sigGlob.scanSync({
					cwd: fixtureRoot,
					absolute: true,
				})) {
					sigFiles.push(f);
				}
				expect(sigFiles).toEqual([]);

				// 7. Assert the stdout mentions the signing-skip message or "OK".
				// (signing skip is logged when COSIGN_ENABLED is not set)
				const combinedOutput = stdout + stderr;
				expect(combinedOutput).toContain("verify-release: OK");
			} finally {
				// Clean up both the fixture dir and the fake bun dir.
				await rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
				await rm(fakeBunDir, { recursive: true, force: true }).catch(() => {});
			}
		},
		180_000,
	);
});
