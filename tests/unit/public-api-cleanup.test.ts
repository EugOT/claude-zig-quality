/**
 * Test 2.4 — `emitDriftDiff` finally-block cleanup never throws.
 *
 * Pre-fix: the finally block ran two `await rm(..., { force: true })`
 * calls in sequence. `force: true` swallows ENOENT but not EACCES /
 * EPERM / EBUSY (e.g. on Windows when an antivirus has the temp file
 * open). When the first `rm` threw, the second never ran and the
 * thrown error masked the caller's intended `finish(1, ...)` exit
 * code by replacing it with a generic Bun crash.
 *
 * Post-fix: cleanup uses `Promise.allSettled` so both `rm` calls
 * always complete and any rejection is collected, never re-thrown.
 *
 * This test stubs `rm` to always reject and asserts `emitDriftDiff`
 * resolves successfully.
 *
 * Extended (plan-15) with:
 *   - trailing-newline assertion on scratch files
 *   - .zig-qm/ location assertion
 *   - parallel call-order invariant (first-rm-rejects, second still called)
 *   - extractSurface grep fallback: empty-match and all pub-form matches
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { emitDriftDiff } from "../../scripts/check-public-api.ts";

let tmpRoot = "";

beforeEach(async () => {
	tmpRoot = await mkdtemp(join(tmpdir(), "public-api-cleanup-"));
});

afterEach(async () => {
	await rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// allSettled / cleanup (existing — mutation sentinel: calls === 2)
// ---------------------------------------------------------------------------

test("emitDriftDiff swallows cleanup errors instead of masking finish()", async () => {
	let calls = 0;
	const failingRm = async (
		_path: string,
		_opts: { force: true },
	): Promise<void> => {
		calls += 1;
		throw new Error("simulated EACCES from antivirus / locked tmp");
	};

	// (a) resolves cleanly even though both rm calls reject
	// (b) still attempts cleanup for both temp files (allSettled, not sequential)
	await expect(
		emitDriftDiff(tmpRoot, "old-surface", "new-surface", failingRm),
	).resolves.toBeUndefined();

	// MUTATION SENTINEL: sequential implementation short-circuits at calls===1.
	// allSettled guarantees both are invoked regardless of individual rejections.
	expect(calls).toBe(2);
});

test("emitDriftDiff calls cleanup for both temp paths on the success path", async () => {
	const removed: string[] = [];
	const noopRm = async (
		path: string,
		_opts: { force: true },
	): Promise<void> => {
		removed.push(path);
	};
	await emitDriftDiff(tmpRoot, "a", "b", noopRm);
	expect(removed).toHaveLength(2);
	expect(removed.every((p) => p.includes(".zig-qm"))).toBe(true);
});

// ---------------------------------------------------------------------------
// Temp-file content and location assertions (new, plan-15)
// ---------------------------------------------------------------------------

describe("emitDriftDiff temp file details", () => {
	test("both scratch files are written under .zig-qm/ inside the given root", async () => {
		const seen: string[] = [];
		const capturingRm = async (
			path: string,
			_opts: { force: true },
		): Promise<void> => {
			seen.push(path);
		};
		await emitDriftDiff(tmpRoot, "baseline-content", "current-content", capturingRm);
		expect(seen).toHaveLength(2);
		const zigQmDir = resolve(tmpRoot, ".zig-qm");
		for (const p of seen) {
			expect(p.startsWith(zigQmDir)).toBe(true);
		}
	});

	test("temp files are written WITH a trailing newline before diff", async () => {
		// Use a noop rm (does NOT delete) so we can read the files after the call.
		const seenPaths: string[] = [];
		const noopRm = async (
			path: string,
			_opts: { force: true },
		): Promise<void> => {
			seenPaths.push(path);
		};

		await emitDriftDiff(tmpRoot, "pub fn foo() void", "pub fn bar() void", noopRm);

		expect(seenPaths).toHaveLength(2);
		for (const p of seenPaths) {
			const raw = await readFile(p, "utf8");
			expect(raw.endsWith("\n")).toBe(true);
		}
		// Manual cleanup since noopRm skipped deletion.
		await Promise.allSettled(seenPaths.map((p) => rm(p, { force: true })));
	});

	test("first rm rejects but second is still called (allSettled parallel invariant)", async () => {
		// Even when rm[0] rejects immediately, allSettled fans out to rm[1].
		// A sequential chain (await rm0; await rm1) would stop at rm0's rejection.
		const callLog: number[] = [];
		let callIdx = 0;
		const partiallyFailingRm = async (
			_path: string,
			_opts: { force: true },
		): Promise<void> => {
			const myIdx = callIdx++;
			callLog.push(myIdx);
			if (myIdx === 0) {
				throw new Error("first rm rejects");
			}
		};

		await expect(
			emitDriftDiff(tmpRoot, "x", "y", partiallyFailingRm),
		).resolves.toBeUndefined();

		// Both calls must have been issued (parallel fan-out via allSettled).
		expect(callLog).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// extractSurface grep fallback — tested via a subprocess that feeds sample
// source text through a temp file, since extractSurface is not exported.
// We drive check-public-api.ts in env-var mode to force the grep path
// (no scripts/zig-api-surface.zig present in tmpRoot).
// ---------------------------------------------------------------------------

const BUN_EXE = process.execPath;
const CHECK_PUBLIC_API = resolve(import.meta.dir, "../../scripts/check-public-api.ts");

async function runGrepFallback(
	sourceLines: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	// Build a minimal tmpdir with only lib.zig — no scripts/zig-api-surface.zig
	// — so extractSurface falls through to the grep path.
	const dir = await mkdtemp(join(tmpdir(), "pub-api-grep-"));
	try {
		const srcDir = join(dir, "src");
		await mkdir(srcDir, { recursive: true });
		await writeFile(join(srcDir, "lib.zig"), sourceLines, "utf8");

		// Point PUBLIC_API_ROOT at our synthetic lib.zig; use a non-existent
		// baseline so the script exits 0 ("no baseline; current surface follows").
		const proc = Bun.spawn(
			[BUN_EXE, CHECK_PUBLIC_API],
			{
				cwd: dir,
				env: {
					...process.env,
					CLAUDE_PROJECT_DIR: dir,
					PUBLIC_API_ROOT: "src/lib.zig",
					PUBLIC_API_BASELINE: ".zig-qm/nonexistent-baseline.txt",
				},
				stdout: "pipe",
				stderr: "pipe",
				stdin: "ignore",
			},
		);
		const [out, err] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		const exitCode = await proc.exited;
		return { stdout: out, stderr: err, exitCode };
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

describe("extractSurface grep fallback (via subprocess, no zig-api-surface.zig)", () => {
	test("returns empty string when no pub declarations present", async () => {
		const src = [
			"const std = @import(\"std\");",
			"fn privateHelper() void {}",
			"var counter: u32 = 0;",
		].join("\n");
		const { stdout, exitCode } = await runGrepFallback(src);
		// exit 0: no baseline → prints skip notice then the (empty) current surface
		expect(exitCode).toBe(0);
		// The surface printed after the skip notice should be empty (no pub lines).
		// stdout contains the "(no public API baseline...)" notice + current surface.
		// Strip the notice line and assert nothing substantive remains.
		const lines = stdout.split("\n").filter(
			(l) => !l.startsWith("(no public API baseline") && l.trim() !== "",
		);
		expect(lines).toHaveLength(0);
	});

	test("grep fallback matches pub fn", async () => {
		const { stdout } = await runGrepFallback("pub fn greet(name: []const u8) void {}\n");
		expect(stdout).toContain("pub fn greet");
	});

	test("grep fallback matches pub extern fn", async () => {
		const { stdout } = await runGrepFallback("pub extern fn open(path: [*:0]const u8, flags: u32) i32;\n");
		expect(stdout).toContain("pub extern fn open");
	});

	test("grep fallback matches pub inline fn", async () => {
		const { stdout } = await runGrepFallback("pub inline fn fast(x: u32) u32 { return x; }\n");
		expect(stdout).toContain("pub inline fn fast");
	});

	test("grep fallback matches pub export fn", async () => {
		const { stdout } = await runGrepFallback("pub export fn exported_symbol() callconv(.C) void {}\n");
		expect(stdout).toContain("pub export fn exported_symbol");
	});

	test("grep fallback matches pub const", async () => {
		const { stdout } = await runGrepFallback("pub const MAX_SIZE: usize = 1024;\n");
		expect(stdout).toContain("pub const MAX_SIZE");
	});

	test("grep fallback matches pub var", async () => {
		const { stdout } = await runGrepFallback("pub var global_counter: u32 = 0;\n");
		expect(stdout).toContain("pub var global_counter");
	});

	test("grep fallback matches multiple pub forms in one file", async () => {
		const src = [
			"pub const Version = \"1.0.0\";",
			"pub var debug_mode: bool = false;",
			"pub fn init() void {}",
			"pub extern fn c_open(path: [*:0]const u8) i32;",
			"pub inline fn clamp(v: u32, lo: u32, hi: u32) u32 { return if (v < lo) lo else if (v > hi) hi else v; }",
			"pub export fn plugin_entry() callconv(.C) void {}",
		].join("\n");
		const { stdout, exitCode } = await runGrepFallback(src);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("pub const Version");
		expect(stdout).toContain("pub var debug_mode");
		expect(stdout).toContain("pub fn init");
		expect(stdout).toContain("pub extern fn c_open");
		expect(stdout).toContain("pub inline fn clamp");
		expect(stdout).toContain("pub export fn plugin_entry");
	});
});
