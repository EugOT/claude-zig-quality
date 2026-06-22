/**
 * Functional tests for scripts/doc-coverage.ts.
 *
 * Spawns the real zig-doc-coverage.zig tool (via mise zig@0.16.0) over a
 * temporary fixture directory with a deliberately undocumented `pub fn`.
 *
 * The test is skipped when no pinned Zig toolchain is available ($ZIG env or
 * mise on PATH) so it degrades explicitly rather than silently.
 *
 * Layout under tmpRoot:
 *   src/
 *     documented.zig   — all pub decls have /// doc comments → exit 0
 *     undocumented.zig — one pub fn has no doc comment     → exit 1
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BUN_EXE = process.execPath;
const DOC_COVERAGE_SCRIPT = resolve(
	import.meta.dir,
	"../../scripts/doc-coverage.ts",
);

// ---------------------------------------------------------------------------
// Toolchain availability check — skip if no pinned zig resolvable.
// ---------------------------------------------------------------------------
function hasPinnedZig(): boolean {
	if (process.env.ZIG && process.env.ZIG.length > 0) return true;
	return Bun.which("mise") !== null;
}

// ---------------------------------------------------------------------------
// Shared tmpdir
// ---------------------------------------------------------------------------
let tmpRoot = "";

beforeEach(async () => {
	tmpRoot = await mkdtemp(join(tmpdir(), "doc-coverage-functional-"));
	await mkdir(join(tmpRoot, "src"), { recursive: true });
	await mkdir(join(tmpRoot, ".claude", "logs"), { recursive: true });
	await mkdir(join(tmpRoot, "scripts"), { recursive: true });
});

afterEach(async () => {
	if (tmpRoot) {
		await rm(tmpRoot, { recursive: true, force: true });
		tmpRoot = "";
	}
});

// ---------------------------------------------------------------------------
// Helper: run doc-coverage.ts as a subprocess over tmpRoot.
// Pass explicit file args so the glob doesn't scan the real repo.
// ---------------------------------------------------------------------------
async function runDocCoverage(
	fileArgs: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn([BUN_EXE, DOC_COVERAGE_SCRIPT, ...fileArgs], {
		cwd: tmpRoot,
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: tmpRoot,
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

// ===========================================================================
// Functional tests — require pinned Zig toolchain
// ===========================================================================

describe("doc-coverage.ts functional (real zig tool)", () => {
	test("exit 1 on a .zig file with an undocumented pub fn", async () => {
		if (!hasPinnedZig()) {
			console.log(
				"(doc-coverage functional test skipped: no pinned Zig toolchain available via $ZIG or mise)",
			);
			return;
		}

		const undocPath = join(tmpRoot, "src", "undocumented.zig");
		// This pub fn has no /// doc comment — the tool should flag it.
		await writeFile(
			undocPath,
			[
				"const std = @import(\"std\");",
				"",
				"/// This one is documented.",
				"pub fn documented(x: u32) u32 {",
				"    return x + 1;",
				"}",
				"",
				"// Missing doc comment intentionally.",
				"pub fn undocumented(x: u32) u32 {",
				"    return x * 2;",
				"}",
			].join("\n"),
		);

		const { stderr, exitCode } = await runDocCoverage([undocPath]);
		expect(exitCode).toBe(1);
		// The stderr message from doc-coverage.ts aggregator must mention the file count
		expect(stderr).toContain("file(s)");
	});

	test("exit 0 on a .zig file where every pub decl is documented", async () => {
		if (!hasPinnedZig()) {
			console.log(
				"(doc-coverage functional test skipped: no pinned Zig toolchain available via $ZIG or mise)",
			);
			return;
		}

		const docPath = join(tmpRoot, "src", "documented.zig");
		await writeFile(
			docPath,
			[
				"const std = @import(\"std\");",
				"",
				"/// Returns x incremented by one.",
				"pub fn increment(x: u32) u32 {",
				"    return x + 1;",
				"}",
				"",
				"/// The answer to everything.",
				"pub const ANSWER: u32 = 42;",
			].join("\n"),
		);

		const { stdout, exitCode } = await runDocCoverage([docPath]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("every pub decl documented");
	});
});
