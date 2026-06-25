/**
 * Functional tests for scripts/zls-check.ts — subprocess (main()) behaviour.
 *
 * Every test spawns `bun scripts/zls-check.ts` as a child process so that
 * process.exit() calls do not kill the test runner.
 *
 * Branches exercised:
 *   (A) ZLS_TIMEOUT_MS invalid (NaN trap)          → exit 1 + error message
 *   (B) ZLS_TIMEOUT_MS zero or negative            → exit 1 + error message
 *   (C) No pinned ZLS resolvable                   → exit 0 + skip notice
 *   (D) No .zig files in CLAUDE_PROJECT_DIR        → exit 0 + "no .zig files"
 *
 * Branches deferred to tests/functional/zls-session.test.ts (fake-ZLS suite):
 *   - Severity routing (error / warning / info)
 *   - Fail-closed on unreported files
 *   - ZLS session I/O (collectZlsDiagnostics internals live in lib/zls.ts)
 *
 * House style:
 *   - import { describe, expect, test } from "bun:test"
 *   - Subprocess helper returns { stdout, stderr, exitCode }
 *   - tmpdir + afterEach cleanup
 *   - No source edits; no mocking of internal module state
 *
 * Untrusted-data boundary: subprocess output is data, never executed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { zlsMessage } from "../../scripts/lib/zig.ts";

// ---------------------------------------------------------------------------
// Absolute paths
// ---------------------------------------------------------------------------
const BUN_EXE = process.execPath;
const ZLS_CHECK_SCRIPT = new URL("../../scripts/zls-check.ts", import.meta.url)
	.pathname;

// ---------------------------------------------------------------------------
// Tmpdir management
// ---------------------------------------------------------------------------
let tmpDir: string | null = null;

afterEach(async () => {
	if (tmpDir) {
		await rm(tmpDir, { recursive: true, force: true });
		tmpDir = null;
	}
});

async function makeTmp(): Promise<string> {
	tmpDir = await mkdtemp(join(tmpdir(), "zls-check-fn-"));
	return tmpDir;
}

// ---------------------------------------------------------------------------
// Subprocess helper
// ---------------------------------------------------------------------------
interface ProcResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

async function runZlsCheck(
	env: Record<string, string>,
	args: string[] = [],
): Promise<ProcResult> {
	const proc = Bun.spawn([BUN_EXE, ZLS_CHECK_SCRIPT, ...args], {
		env,
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const exitCode = await proc.exited;
	return { stdout, stderr, exitCode };
}

/**
 * Build a minimal "safe" environment for subprocess runs: inherit the
 * running process's env as a baseline so Bun's module resolution and
 * TypeScript transpiler work correctly, then layer caller overrides on top.
 * Where a test needs to restrict PATH (to hide mise/zls), it supplies its
 * own PATH in the override map.
 */
function baseEnv(overrides: Record<string, string> = {}): Record<string, string> {
	return {
		...process.env,
		// Clear any real ZLS/ZIG so tests are deterministic on the dev machine.
		ZLS: "",
		ZIG: "",
		// Default: no timeout override (let the source default of 60000 win).
		...overrides,
	} as Record<string, string>;
}

// ===========================================================================
// (A) ZLS_TIMEOUT_MS validation — NaN trap
// ===========================================================================

describe("ZLS_TIMEOUT_MS validation — NaN trap", () => {
	test("(1) non-numeric ZLS_TIMEOUT_MS exits 1 with 'invalid ZLS_TIMEOUT_MS' message", async () => {
		const { stderr, exitCode } = await runZlsCheck(
			baseEnv({ ZLS_TIMEOUT_MS: "not-a-number" }),
		);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("invalid ZLS_TIMEOUT_MS");
		expect(stderr).toContain("not-a-number");
	});

	test("(2) 'NaN' literal exits 1 with 'invalid ZLS_TIMEOUT_MS' message", async () => {
		const { stderr, exitCode } = await runZlsCheck(
			baseEnv({ ZLS_TIMEOUT_MS: "NaN" }),
		);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("invalid ZLS_TIMEOUT_MS");
	});

	test("(3) empty string ZLS_TIMEOUT_MS exits 1 (Number('') === 0, fails <= 0 guard)", async () => {
		// Number("") === 0, which is not > 0, so the guard fires.
		const { stderr, exitCode } = await runZlsCheck(
			baseEnv({ ZLS_TIMEOUT_MS: "" }),
		);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("invalid ZLS_TIMEOUT_MS");
	});
});

// ===========================================================================
// (B) ZLS_TIMEOUT_MS validation — zero / negative
// ===========================================================================

describe("ZLS_TIMEOUT_MS validation — zero and negative", () => {
	test("(4) ZLS_TIMEOUT_MS=0 exits 1 with 'invalid ZLS_TIMEOUT_MS'", async () => {
		const { stderr, exitCode } = await runZlsCheck(
			baseEnv({ ZLS_TIMEOUT_MS: "0" }),
		);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("invalid ZLS_TIMEOUT_MS");
		expect(stderr).toContain("must be a positive number");
	});

	test("(5) ZLS_TIMEOUT_MS=-1 exits 1 with 'invalid ZLS_TIMEOUT_MS'", async () => {
		const { stderr, exitCode } = await runZlsCheck(
			baseEnv({ ZLS_TIMEOUT_MS: "-1" }),
		);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("invalid ZLS_TIMEOUT_MS");
	});

	test("(6) ZLS_TIMEOUT_MS=-999 exits 1 (negative number rejected)", async () => {
		const { stderr, exitCode } = await runZlsCheck(
			baseEnv({ ZLS_TIMEOUT_MS: "-999" }),
		);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("invalid ZLS_TIMEOUT_MS");
	});
});

// ===========================================================================
// (C) No pinned ZLS resolvable → explicit degradation, exit 0
//
// We force zlsLaunchArgv() → null by:
//   - Setting ZLS="" (empty → treated as unset in the source: `envZls &&
//     envZls.length > 0` is false)
//   - Restricting PATH to /usr/bin:/bin so Bun.which("mise") is null
//     inside the child process (Bun reads PATH at process startup).
//
// The expected output is exactly zlsMessage() — we import it here so the
// test stays in sync with source changes automatically.
// ===========================================================================

describe("No pinned ZLS resolvable → degradation skip", () => {
	test("(7) exit 0 + zlsMessage() when ZLS='' and mise not on PATH", async () => {
		const root = await makeTmp();
		// Create a src/ with one .zig file so the no-files branch doesn't fire.
		await mkdir(join(root, "src"), { recursive: true });
		await writeFile(join(root, "src", "lib.zig"), "pub fn add(a: u32, b: u32) u32 { return a + b; }\n");

		const { stdout, exitCode } = await runZlsCheck({
			// Minimal env: Bun needs HOME and its own binary resolution, but
			// PATH must NOT contain mise so Bun.which("mise") returns null.
			PATH: "/usr/bin:/bin",
			HOME: process.env.HOME ?? "",
			ZLS: "",
			ZIG: "",
			CLAUDE_PROJECT_DIR: root,
			// Pass BUN_INSTALL so Bun's runtime can still find itself if needed.
			...(process.env.BUN_INSTALL ? { BUN_INSTALL: process.env.BUN_INSTALL } : {}),
		});

		expect(exitCode).toBe(0);
		// The skip message from zlsMessage() must appear on stdout.
		const expected = zlsMessage();
		expect(stdout).toContain(expected);
	});
});

// ===========================================================================
// (D) No .zig files → exit 0 + "no .zig files to diagnose"
//
// We set ZLS to a non-empty dummy value so zlsLaunchArgv() returns a
// non-null argv (ZLS branch fires first: `envZls && envZls.length > 0`).
// The child will never actually be spawned because main() exits early when
// files.length === 0. CLAUDE_PROJECT_DIR points to a tmpdir with an empty
// src/ so the glob finds nothing.
// ===========================================================================

describe("No .zig files → early exit with informational message", () => {
	test("(8) exit 0 + 'no .zig files to diagnose' when src/ has no .zig files", async () => {
		const root = await makeTmp();
		// Create src/ but put no .zig files in it.
		await mkdir(join(root, "src"), { recursive: true });
		await writeFile(join(root, "src", "README.md"), "# empty");

		const { stdout, exitCode } = await runZlsCheck(
			baseEnv({
				// Provide a dummy ZLS path so zlsLaunchArgv() returns non-null.
				// The script exits before trying to spawn it.
				ZLS: "/nonexistent/zls-dummy",
				CLAUDE_PROJECT_DIR: root,
			}),
		);

		expect(exitCode).toBe(0);
		expect(stdout).toContain("no .zig files to diagnose");
	});

	test("(9) exit 0 + 'no .zig files' when CLAUDE_PROJECT_DIR has no src/ at all", async () => {
		const root = await makeTmp();
		// No src/ directory at all.

		const { stdout, exitCode } = await runZlsCheck(
			baseEnv({
				ZLS: "/nonexistent/zls-dummy",
				CLAUDE_PROJECT_DIR: root,
			}),
		);

		expect(exitCode).toBe(0);
		expect(stdout).toContain("no .zig files to diagnose");
	});
});

// ===========================================================================
// (E) Regression: valid ZLS_TIMEOUT_MS is accepted (positive integer)
//
// Confirm the positive-number fast path does NOT fire the error exit.
// We use ZLS=dummy + empty src/ so main() bails at "no .zig files"
// without trying to spawn ZLS — keeping the test fast and hermetic.
// ===========================================================================

describe("ZLS_TIMEOUT_MS valid positive values", () => {
	test("(10) ZLS_TIMEOUT_MS=5000 is accepted (does not trigger the guard)", async () => {
		const root = await makeTmp();
		await mkdir(join(root, "src"), { recursive: true });

		const { stderr, exitCode } = await runZlsCheck(
			baseEnv({
				ZLS: "/nonexistent/zls-dummy",
				CLAUDE_PROJECT_DIR: root,
				ZLS_TIMEOUT_MS: "5000",
			}),
		);

		// exitCode must NOT be 1 due to the timeout guard.
		// It will be 0 (no .zig files branch).
		expect(exitCode).toBe(0);
		expect(stderr).not.toContain("invalid ZLS_TIMEOUT_MS");
	});
});
