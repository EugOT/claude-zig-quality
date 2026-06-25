/**
 * Functional (subprocess) tests for scripts/check-public-api.ts.
 *
 * These tests spawn check-public-api.ts as a real child process so that
 * process.exit() calls, env-var consumption, and file-system side-effects are
 * exercised end-to-end without mocking internals.
 *
 * All Zig toolchain extraction is avoided: we set PUBLIC_API_ROOT to a plain
 * .zig file with no `scripts/zig-api-surface.zig` present in the tmpdir, so
 * the script always falls through to the grep/sed fallback path. No real `zig`
 * binary is required.
 *
 * Env vars honored by check-public-api.ts:
 *   PUBLIC_API_ROOT      — path to the root .zig file (relative to repo root)
 *   PUBLIC_API_BASELINE  — path to the baseline snapshot file
 *   CLAUDE_PROJECT_DIR   — overrides repoRoot() in scripts/lib/runtime.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BUN_EXE = process.execPath;
const CHECK_PUBLIC_API = resolve(
	import.meta.dir,
	"../../scripts/check-public-api.ts",
);

// ---------------------------------------------------------------------------
// Shared tmpdir per test
// ---------------------------------------------------------------------------

let tmpRoot = "";

beforeEach(async () => {
	tmpRoot = await mkdtemp(join(tmpdir(), "cpa-functional-"));
	// Always create the src/ dir so PUBLIC_API_ROOT can point into it.
	await mkdir(join(tmpRoot, "src"), { recursive: true });
	// Always create .zig-qm/ so the script can write temp files without needing
	// a real repo (mkdir -p is called inside emitDriftDiff but only for .zig-qm;
	// for the baseline path we ensure the parent exists here).
	await mkdir(join(tmpRoot, ".zig-qm"), { recursive: true });
	// Ensure the log dir exists so appendJsonl doesn't fail.
	await mkdir(join(tmpRoot, ".claude", "logs"), { recursive: true });
});

afterEach(async () => {
	if (tmpRoot) {
		await rm(tmpRoot, { recursive: true, force: true });
		tmpRoot = "";
	}
});

// ---------------------------------------------------------------------------
// Helper: spawn check-public-api.ts as a subprocess with controlled env.
// ---------------------------------------------------------------------------

interface RunResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

async function runCheckApi(
	args: string[] = [],
	opts: {
		rootFile?: string;
		baselinePath?: string;
		rootFileContent?: string;
		baselineContent?: string | null;
	} = {},
): Promise<RunResult> {
	const rootFile = opts.rootFile ?? "src/lib.zig";
	const baselinePath = opts.baselinePath ?? ".zig-qm/public-api.txt";

	// Write the root .zig file if content provided.
	if (opts.rootFileContent !== undefined) {
		const absRoot = join(tmpRoot, rootFile);
		await mkdir(join(tmpRoot, rootFile, "..").replace(/\/[^/]+$/, ""), {
			recursive: true,
		});
		await writeFile(absRoot, opts.rootFileContent, "utf8");
	}

	// Write the baseline file if content provided (null means "don't create it").
	if (opts.baselineContent !== null && opts.baselineContent !== undefined) {
		const absBaseline = join(tmpRoot, baselinePath);
		await mkdir(
			absBaseline.substring(0, absBaseline.lastIndexOf("/")),
			{ recursive: true },
		);
		await writeFile(absBaseline, opts.baselineContent, "utf8");
	}

	const proc = Bun.spawn([BUN_EXE, CHECK_PUBLIC_API, ...args], {
		cwd: tmpRoot,
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: tmpRoot,
			PUBLIC_API_ROOT: rootFile,
			PUBLIC_API_BASELINE: baselinePath,
		},
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
// Tests
// ---------------------------------------------------------------------------

describe("check-public-api.ts functional", () => {
	test("exit 0 + skip message when the root .zig file is absent", async () => {
		// Do NOT write a root file — so Bun.file(absRoot).exists() returns false.
		const { stdout, exitCode } = await runCheckApi([], {
			rootFileContent: undefined, // don't create the file
			baselineContent: null,
		});
		expect(exitCode).toBe(0);
		expect(stdout).toContain("skipping public surface check");
	});

	test("exit 0 when baseline absent (first run)", async () => {
		const src = "pub fn hello() void {}\n";
		const { stdout, exitCode } = await runCheckApi([], {
			rootFileContent: src,
			baselineContent: null, // no baseline file
		});
		expect(exitCode).toBe(0);
		// Script prints the "(no public API baseline; current surface follows)" notice.
		expect(stdout).toContain("no public API baseline");
	});

	test("--write creates the baseline dir + file with trailing newline", async () => {
		const src = "pub fn hello() void {}\n";
		const baselinePath = ".zig-qm/nested/subdir/public-api.txt";
		const { stdout, exitCode } = await runCheckApi(["--write"], {
			rootFile: "src/lib.zig",
			baselinePath,
			rootFileContent: src,
			baselineContent: null, // doesn't exist yet
		});
		expect(exitCode).toBe(0);
		expect(stdout).toContain("wrote baseline");

		// Verify the file exists and ends with \n.
		const written = await readFile(join(tmpRoot, baselinePath), "utf8");
		expect(written.endsWith("\n")).toBe(true);
		// And it contains the pub declaration we grep'd.
		expect(written).toContain("pub fn hello");
	});

	test("bare 'write' arg (without --) also writes baseline", async () => {
		const src = "pub const VERSION: []const u8 = \"1.0\";\n";
		const baselinePath = ".zig-qm/public-api.txt";
		const { stdout, exitCode } = await runCheckApi(["write"], {
			rootFileContent: src,
			baselinePath,
			baselineContent: null,
		});
		expect(exitCode).toBe(0);
		expect(stdout).toContain("wrote baseline");
		const written = await readFile(join(tmpRoot, baselinePath), "utf8");
		expect(written.endsWith("\n")).toBe(true);
		expect(written).toContain("pub const VERSION");
	});

	test("exit 0 + 'surface matches baseline' when surface unchanged", async () => {
		const src = "pub fn greet(name: []const u8) void {}\n";
		// First, write the baseline via --write to get the exact surface text.
		await runCheckApi(["--write"], {
			rootFileContent: src,
			baselineContent: null,
		});
		// Now run without --write: surface matches baseline → exit 0.
		const { stdout, exitCode } = await runCheckApi([], {
			rootFileContent: src,
		});
		expect(exitCode).toBe(0);
		expect(stdout).toContain("surface matches baseline");
	});

	test("exit 1 + unified-diff markers when surface drifts", async () => {
		// Write a baseline with one pub fn.
		const baselineSrc = "pub fn original() void {}\n";
		await runCheckApi(["--write"], {
			rootFileContent: baselineSrc,
			baselineContent: null,
		});

		// Now change the source — add a new pub fn.
		const driftedSrc = "pub fn original() void {}\npub fn added() void {}\n";
		const { stdout, exitCode } = await runCheckApi([], {
			rootFileContent: driftedSrc,
		});
		expect(exitCode).toBe(1);
		// unified diff markers must appear on stdout.
		expect(stdout).toMatch(/^[-+]{3}/m); // --- or +++ header
		expect(stdout).toMatch(/^\+.*pub fn added/m);
	});

	test("exit 1 stderr contains 'public surface drifted' on drift", async () => {
		const baselineSrc = "pub const A: u8 = 1;\n";
		await runCheckApi(["--write"], {
			rootFileContent: baselineSrc,
			baselineContent: null,
		});

		const driftedSrc = "pub const B: u8 = 2;\n";
		const { stderr, exitCode } = await runCheckApi([], {
			rootFileContent: driftedSrc,
		});
		expect(exitCode).toBe(1);
		expect(stderr).toContain("public surface drifted");
	});

	test("both --write and bare write arg work identically", async () => {
		const src = "pub fn dual_mode() void {}\n";

		// Test --write
		const r1 = await runCheckApi(["--write"], {
			rootFileContent: src,
			baselinePath: ".zig-qm/baseline-dash.txt",
			baselineContent: null,
		});
		expect(r1.exitCode).toBe(0);
		expect(r1.stdout).toContain("wrote baseline");

		// Test bare write
		const r2 = await runCheckApi(["write"], {
			rootFileContent: src,
			baselinePath: ".zig-qm/baseline-bare.txt",
			baselineContent: null,
		});
		expect(r2.exitCode).toBe(0);
		expect(r2.stdout).toContain("wrote baseline");

		// Both baseline files should have identical content.
		const f1 = await readFile(join(tmpRoot, ".zig-qm/baseline-dash.txt"), "utf8");
		const f2 = await readFile(join(tmpRoot, ".zig-qm/baseline-bare.txt"), "utf8");
		expect(f1).toBe(f2);
	});
});
