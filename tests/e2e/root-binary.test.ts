/**
 * E2E test: the compiled `claude-zig-quality` binary exits 0 and prints the
 * expected greeting on stdout.
 *
 * Strategy:
 *   - Build: `mise x zig@0.16.0 -- zig build` from the repo root.
 *     This produces `zig-out/bin/claude-zig-quality`.
 *   - Run: spawn the binary and capture stdout.
 *   - Assert: exit code 0 AND stdout contains "Hello, claude-zig-quality!".
 *
 * Skip condition: `mise` must be on PATH AND `zig@0.16.0` must be resolvable.
 *   If either is absent the test logs a skip notice and passes — the Zig
 *   embedded tests in src/root.zig already cover the logic layer.
 *
 * Timeout: 120 000 ms. A cold Zig build on a developer box can take ~60-90 s;
 *   CI pre-warms the cache so it is typically faster. Do NOT lower this.
 *
 * Binary name: `claude-zig-quality`  (from `.name = "claude-zig-quality"` in
 *   build.zig line 63).
 * Expected greeting: `Hello, claude-zig-quality!`  (from lib.hello(gpa, io,
 *   "claude-zig-quality") → std.fmt.allocPrint "Hello, {s}!" in src/lib.zig).
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Repo root — two levels up from tests/e2e/
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dir, "../..");

// ---------------------------------------------------------------------------
// Binary paths
// ---------------------------------------------------------------------------

const BINARY_NAME = "claude-zig-quality";
const BINARY_PATH = resolve(REPO_ROOT, "zig-out", "bin", BINARY_NAME);

// ---------------------------------------------------------------------------
// Expected output
// ---------------------------------------------------------------------------

const EXPECTED_GREETING = "Hello, claude-zig-quality!";

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
// E2E test
// ---------------------------------------------------------------------------

describe("root binary e2e", () => {
	test(
		"binary exits 0 and prints expected greeting",
		async () => {
			if (!TOOLCHAIN_AVAILABLE) {
				console.log(
					"(skipped: mise + zig@0.16.0 not available on this host)",
				);
				return;
			}

			// 1. Build the binary.
			const build = Bun.spawnSync(
				["mise", "x", "zig@0.16.0", "--", "zig", "build"],
				{
					cwd: REPO_ROOT,
					stdout: "pipe",
					stderr: "pipe",
					stdin: "ignore",
				},
			);

			if (build.exitCode !== 0) {
				console.error("=== zig build stdout ===");
				console.error(build.stdout.toString());
				console.error("=== zig build stderr ===");
				console.error(build.stderr.toString());
			}
			expect(build.exitCode).toBe(0);

			// 2. Run the compiled binary.
			const proc = Bun.spawnSync([BINARY_PATH], {
				cwd: REPO_ROOT,
				stdout: "pipe",
				stderr: "pipe",
				stdin: "ignore",
			});

			const stdout = proc.stdout.toString();
			const stderr = proc.stderr.toString();

			if (proc.exitCode !== 0) {
				console.error("=== binary stdout ===");
				console.error(stdout);
				console.error("=== binary stderr ===");
				console.error(stderr);
			}

			// 3. Assert exit code 0.
			expect(proc.exitCode).toBe(0);

			// 4. Assert stdout contains the expected greeting.
			expect(stdout).toContain(EXPECTED_GREETING);
		},
		120_000,
	);
});
