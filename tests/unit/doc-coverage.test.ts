/**
 * Unit tests for scripts/doc-coverage.ts.
 *
 * Coverage scope:
 *   - resolveFiles(root, argv): argv paths, no-argv glob, sort/absolute guarantees
 *   - main(zig): injected stub zig — no-files skip, failure count, pass, passthrough, per-file counting
 *
 * main() calls process.exit(), so all main() tests run in a SUBPROCESS:
 *   1. write a fixture .ts to tmpdir that imports main by absolute path and
 *      calls it with a stub `zig` whose behavior is scripted via env vars.
 *   2. spawn `bun <fixture.ts>` and assert exit code + output.
 *
 * Stub zig behavior is communicated via:
 *   STUB_ZIG_EXITS   — comma-separated per-file exit codes, e.g. "0,1,0"
 *   STUB_ZIG_STDOUT  — text the stub writes to stdout for every invocation
 *   STUB_ZIG_STDERR  — text the stub writes to stderr for every invocation
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BUN_EXE = process.execPath;
const DOC_COVERAGE_MODULE = resolve(
	import.meta.dir,
	"../../scripts/doc-coverage.ts",
);

// ---------------------------------------------------------------------------
// resolveFiles — imported in-process (no process.exit calls there)
// ---------------------------------------------------------------------------
import { resolveFiles } from "../../scripts/doc-coverage.ts";

// ---------------------------------------------------------------------------
// Tmpdir management
// ---------------------------------------------------------------------------
let tmpDir: string | null = null;

beforeEach(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), "doc-coverage-unit-"));
});

afterEach(async () => {
	if (tmpDir) {
		await rm(tmpDir, { recursive: true, force: true });
		tmpDir = null;
	}
});

// ---------------------------------------------------------------------------
// Helper: spawn a fixture script in a child process.
// ---------------------------------------------------------------------------
async function runFixture(
	fixturePath: string,
	extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn([BUN_EXE, fixturePath], {
		env: { ...process.env, ...extraEnv },
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

/**
 * Write a fixture .ts file to tmpDir and return its path.
 * The fixture imports `main` from doc-coverage.ts and calls it with a
 * stub `zig` whose behavior is driven by env vars:
 *   STUB_ZIG_EXITS   — comma-separated exit codes, one per file call
 *   STUB_ZIG_STDOUT  — stdout text emitted by each call
 *   STUB_ZIG_STDERR  — stderr text emitted by each call
 *   STUB_ZIG_ROOT    — CLAUDE_PROJECT_DIR override so resolveFiles scans a tmpdir
 */
async function writeMainFixture(dir: string): Promise<string> {
	const fixturePath = join(dir, "fixture-main.ts");
	// Use string concatenation to build the fixture content — no nested backticks.
	const content = [
		'import { main } from "' + DOC_COVERAGE_MODULE + '";',
		"",
		"// Stub zig driven by env",
		"let callIndex = 0;",
		"const exits = (process.env.STUB_ZIG_EXITS ?? '0').split(',').map(Number);",
		"const stubStdout = process.env.STUB_ZIG_STDOUT ?? '';",
		"const stubStderr = process.env.STUB_ZIG_STDERR ?? '';",
		"",
		"// Override CLAUDE_PROJECT_DIR so resolveFiles scans our tmpdir",
		"if (process.env.STUB_ZIG_ROOT) {",
		"  process.env.CLAUDE_PROJECT_DIR = process.env.STUB_ZIG_ROOT;",
		"}",
		"",
		"function stubZig(_args: string[]): { code: number; stdout: Buffer; stderr: Buffer } {",
		"  const idx = callIndex < exits.length ? callIndex : exits.length - 1;",
		"  callIndex++;",
		"  return {",
		"    code: exits[idx],",
		"    stdout: Buffer.from(stubStdout),",
		"    stderr: Buffer.from(stubStderr),",
		"  };",
		"}",
		"",
		"await main(stubZig as any);",
	].join("\n");
	await writeFile(fixturePath, content, "utf8");
	return fixturePath;
}

// ===========================================================================
// resolveFiles — in-process tests (no process.exit)
// ===========================================================================

describe("resolveFiles", () => {
	test("(1) argv paths resolved ABSOLUTE against root, not cwd", async () => {
		const root = tmpDir as string;
		// Pass relative paths; they should be resolved against root, not process.cwd().
		const result = await resolveFiles(root, ["foo/bar.zig", "baz.zig"]);
		expect(result).toEqual([
			resolve(root, "foo/bar.zig"),
			resolve(root, "baz.zig"),
		]);
		// Must be absolute
		for (const p of result) {
			expect(p.startsWith("/")).toBe(true);
		}
		// Must be rooted at `root`, not at cwd
		for (const p of result) {
			expect(p.startsWith(root)).toBe(true);
		}
	});

	test("(2) no-argv → sorted absolute list from src/**/*.zig glob", async () => {
		const root = tmpDir as string;
		// Create a few .zig files under src/
		await mkdir(join(root, "src", "sub"), { recursive: true });
		await writeFile(join(root, "src", "z_last.zig"), "");
		await writeFile(join(root, "src", "a_first.zig"), "");
		await writeFile(join(root, "src", "sub", "middle.zig"), "");
		// Non-.zig files must not appear
		await writeFile(join(root, "src", "ignore.txt"), "");

		const result = await resolveFiles(root, []);

		// All entries must be absolute paths
		for (const p of result) {
			expect(p.startsWith("/")).toBe(true);
			expect(p.startsWith(root)).toBe(true);
		}
		// Must be sorted
		const sorted = [...result].sort();
		expect(result).toEqual(sorted);
		// Only .zig files
		for (const p of result) {
			expect(p.endsWith(".zig")).toBe(true);
		}
		// All three .zig files present
		expect(result.length).toBe(3);
		const basenames = result.map((p) => p.split("/").pop());
		expect(basenames).toContain("a_first.zig");
		expect(basenames).toContain("z_last.zig");
		expect(basenames).toContain("middle.zig");
	});
});

// ===========================================================================
// main(zig) — subprocess tests
// All tests write a fixture, spawn it, and assert on exit code + output.
// ===========================================================================

describe("main(zig) via subprocess", () => {
	test("(3) exit 0 + skip message when resolveFiles yields no files", async () => {
		const dir = tmpDir as string;
		// Point STUB_ZIG_ROOT at an empty tmpdir that has no src/ — resolveFiles
		// returns [] because the glob finds nothing and argv is empty (fixture
		// calls main() which reads process.argv.slice(2) = []).
		const emptyRoot = join(dir, "empty-root");
		await mkdir(emptyRoot, { recursive: true });

		const fixturePath = await writeMainFixture(dir);
		const { stdout, exitCode } = await runFixture(fixturePath, {
			STUB_ZIG_EXITS: "0",
			STUB_ZIG_ROOT: emptyRoot,
		});
		expect(exitCode).toBe(0);
		expect(stdout).toContain("no .zig files to check");
	});

	test("(4) exit 1 + file-count in stderr when stub exits 1 for one file", async () => {
		const dir = tmpDir as string;
		// Create a root with one .zig file so resolveFiles returns 1 file.
		const fakeRoot = join(dir, "fake-root");
		await mkdir(join(fakeRoot, "src"), { recursive: true });
		await writeFile(join(fakeRoot, "src", "lib.zig"), "pub fn foo() void {}");

		const fixturePath = await writeMainFixture(dir);
		const { stderr, exitCode } = await runFixture(fixturePath, {
			STUB_ZIG_EXITS: "1",
			STUB_ZIG_ROOT: fakeRoot,
		});
		expect(exitCode).toBe(1);
		expect(stderr).toContain("1 file(s)");
		expect(stderr).toContain("undocumented public declarations");
	});

	test("(5) exit 0 'every pub decl documented' when stub returns code 0 for all", async () => {
		const dir = tmpDir as string;
		const fakeRoot = join(dir, "fake-root");
		await mkdir(join(fakeRoot, "src"), { recursive: true });
		await writeFile(join(fakeRoot, "src", "a.zig"), "/// doc\npub fn a() void {}");
		await writeFile(join(fakeRoot, "src", "b.zig"), "/// doc\npub fn b() void {}");

		const fixturePath = await writeMainFixture(dir);
		const { stdout, exitCode } = await runFixture(fixturePath, {
			STUB_ZIG_EXITS: "0,0",
			STUB_ZIG_ROOT: fakeRoot,
		});
		expect(exitCode).toBe(0);
		expect(stdout).toContain("every pub decl documented");
	});

	test("(6) zig stdout/stderr passed through unchanged", async () => {
		const dir = tmpDir as string;
		const fakeRoot = join(dir, "fake-root");
		await mkdir(join(fakeRoot, "src"), { recursive: true });
		await writeFile(join(fakeRoot, "src", "lib.zig"), "pub fn x() void {}");

		const sentinel = "SENTINEL_OUTPUT_abc123";
		const fixturePath = await writeMainFixture(dir);
		const { stdout, stderr, exitCode } = await runFixture(fixturePath, {
			STUB_ZIG_EXITS: "0",
			STUB_ZIG_STDOUT: sentinel,
			STUB_ZIG_ROOT: fakeRoot,
		});
		// The sentinel text from stub stdout must appear in the captured output
		expect(stdout).toContain(sentinel);
		// Exit 0 because stub returns code 0
		expect(exitCode).toBe(0);
	});

	test("(7) failures counted per-FILE: stub exits 1 for 2 files → message says '2 file(s)'", async () => {
		const dir = tmpDir as string;
		const fakeRoot = join(dir, "fake-root");
		await mkdir(join(fakeRoot, "src"), { recursive: true });
		// Two .zig files so resolveFiles returns 2 files
		await writeFile(join(fakeRoot, "src", "one.zig"), "pub fn one() void {}");
		await writeFile(join(fakeRoot, "src", "two.zig"), "pub fn two() void {}");

		const fixturePath = await writeMainFixture(dir);
		const { stderr, exitCode } = await runFixture(fixturePath, {
			// Both files fail
			STUB_ZIG_EXITS: "1,1",
			STUB_ZIG_ROOT: fakeRoot,
		});
		expect(exitCode).toBe(1);
		// Regression: counted per FILE, not per line — must say exactly "2 file(s)"
		expect(stderr).toContain("2 file(s)");
	});
});
