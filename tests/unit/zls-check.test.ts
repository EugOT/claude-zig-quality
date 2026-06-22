/**
 * Unit tests for scripts/zls-check.ts — resolveFiles() + pure helpers.
 *
 * Coverage scope:
 *   - resolveFiles(root, argv): explicit-argv path, no-argv glob, sort order
 *   - path.relative display correctness (documented: the inline relative()
 *     call in main() is covered here via a pure extraction; the functional
 *     suite covers it end-to-end)
 *
 * Functions that call process.exit() (main()) are tested exclusively via
 * child-process spawning in tests/functional/zls-check.test.ts so they
 * cannot kill the test runner.
 *
 * Untrusted-data boundary: test inputs are controlled strings, never
 * executed or interpreted as directives.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { resolveFiles } from "../../scripts/zls-check.ts";

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
	tmpDir = await mkdtemp(join(tmpdir(), "zls-check-unit-"));
	return tmpDir;
}

// ---------------------------------------------------------------------------
// resolveFiles(root, argv)
// ---------------------------------------------------------------------------

describe("resolveFiles — explicit argv", () => {
	test("(1) relative paths in argv are resolved absolute against root", async () => {
		const root = "/repo/root";
		const argv = ["src/foo.zig", "src/bar.zig"];
		const result = await resolveFiles(root, argv);
		expect(result).toEqual([
			resolve(root, "src/foo.zig"),
			resolve(root, "src/bar.zig"),
		]);
	});

	test("(2) absolute paths in argv are preserved as-is", async () => {
		const root = "/repo/root";
		const argv = ["/absolute/path/foo.zig"];
		const result = await resolveFiles(root, argv);
		expect(result).toEqual(["/absolute/path/foo.zig"]);
	});

	test("(3) argv order is preserved (no sorting when explicit)", async () => {
		const root = "/repo/root";
		// intentionally reverse-sorted
		const argv = ["src/z.zig", "src/a.zig", "src/m.zig"];
		const result = await resolveFiles(root, argv);
		expect(result).toEqual([
			resolve(root, "src/z.zig"),
			resolve(root, "src/a.zig"),
			resolve(root, "src/m.zig"),
		]);
	});

	test("(4) single argv entry → single-element array", async () => {
		const root = "/some/project";
		const result = await resolveFiles(root, ["src/main.zig"]);
		expect(result).toHaveLength(1);
		expect(result[0]).toBe(resolve(root, "src/main.zig"));
	});
});

describe("resolveFiles — no-argv glob (src/**/*.zig)", () => {
	test("(5) returns empty array when src/ contains no .zig files", async () => {
		const root = await makeTmp();
		await mkdir(join(root, "src"), { recursive: true });
		// Write a non-.zig file to confirm the glob is selective.
		await writeFile(join(root, "src", "readme.txt"), "hello");
		const result = await resolveFiles(root, []);
		expect(result).toEqual([]);
	});

	test("(6) discovers .zig files under src/ and returns them sorted", async () => {
		const root = await makeTmp();
		await mkdir(join(root, "src", "sub"), { recursive: true });
		// Write in reverse-sorted order to verify the sort.
		await writeFile(join(root, "src", "z_last.zig"), "");
		await writeFile(join(root, "src", "a_first.zig"), "");
		await writeFile(join(root, "src", "sub", "m_middle.zig"), "");
		const result = await resolveFiles(root, []);
		// All three files are found.
		expect(result).toHaveLength(3);
		// Results are absolute paths under root.
		for (const f of result) {
			expect(f.startsWith(root)).toBe(true);
		}
		// Results are sorted (lexicographic on the full absolute path).
		const sorted = [...result].sort();
		expect(result).toEqual(sorted);
	});

	test("(7) does NOT include .zig files outside src/ (e.g. scripts/)", async () => {
		const root = await makeTmp();
		await mkdir(join(root, "src"), { recursive: true });
		await mkdir(join(root, "scripts"), { recursive: true });
		await writeFile(join(root, "src", "lib.zig"), "");
		await writeFile(join(root, "scripts", "emit-sbom.zig"), "");
		const result = await resolveFiles(root, []);
		// Only the src/ file should appear.
		expect(result).toHaveLength(1);
		expect(result[0]).toBe(join(root, "src", "lib.zig"));
	});

	test("(8) empty argv with empty src/ returns [] (no .zig files at all)", async () => {
		const root = await makeTmp();
		// Do not create src/ at all.
		const result = await resolveFiles(root, []);
		expect(result).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// path.relative display correctness — pure regression (CodeRabbit).
//
// main() uses:
//   const rel = relative(root, file);
//   const msg = `${rel}:${line}:${col}: ...`
//
// The CodeRabbit comment flagged a naive startsWith+slice would
// mis-slice when an arg shares a prefix with root but sits outside it.
// We test the Node.js path.relative() function directly — this is the
// exact call site.  The functional suite covers the rendered output.
// ---------------------------------------------------------------------------

describe("path.relative display correctness", () => {
	test("(9) file outside root resolves to '../'-prefixed path, not a mis-sliced one", () => {
		const root = "/repo";
		const file = "/repox/foo.zig";
		// Naive startsWith('/repo')+slice(5) would produce 'x/foo.zig'
		// path.relative correctly produces '../repox/foo.zig'
		expect(relative(root, file)).toBe("../repox/foo.zig");
	});

	test("(10) file inside root produces a relative path without leading ../", () => {
		const root = "/repo";
		const file = "/repo/src/lib.zig";
		expect(relative(root, file)).toBe("src/lib.zig");
	});

	test("(11) file in a sibling directory", () => {
		const root = "/workspace/project";
		const file = "/workspace/other/foo.zig";
		expect(relative(root, file)).toBe("../other/foo.zig");
	});
});
