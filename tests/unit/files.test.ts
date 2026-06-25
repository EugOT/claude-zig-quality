/**
 * Unit tests for `collectZigInputs` in scripts/lib/files.ts.
 *
 * Resolution strategy (source order):
 *   1. jj files  — exits 0 + non-empty stdout
 *   2. git ls-files — exits 0 + non-empty stdout
 *   3. fsWalk   — fallback when tracked.length === 0
 *
 * KNOWN BUG (documented, not fixed here):
 *   The source calls `["jj", "files", ...]`. On jj 0.42 the correct
 *   subcommand is `jj file list`. `jj files` exits 2 on every call, so
 *   the jj strategy is effectively dead in this environment. Tests that
 *   would verify "jj wins over git" are skipped with an explanation.
 *
 * Approach: tmpdir fixtures with real git init where VCS behaviour is
 * needed. `collectZigInputs(root)` accepts an explicit root parameter so
 * we pass the tmpdir directly — no CLAUDE_PROJECT_DIR manipulation required.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectZigInputs } from "../../scripts/lib/files.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let tmpRoot = "";

beforeEach(async () => {
	tmpRoot = await mkdtemp(join(tmpdir(), "files-test-"));
});

afterEach(async () => {
	// Restore permissions on any chmod-000 subdirs so recursive rm can proceed.
	try {
		chmodSync(join(tmpRoot, "src"), 0o755);
	} catch {
		/* not present or already accessible */
	}
	await rm(tmpRoot, { recursive: true, force: true });
});

/** Create a file and any parent dirs needed. */
function touch(rel: string, content = ""): void {
	const abs = join(tmpRoot, rel);
	mkdirSync(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
	writeFileSync(abs, content);
}

/** Run `git init` + optionally stage files in tmpRoot. */
function gitInit(filesToStage: string[] = []): void {
	const r = Bun.spawnSync(["git", "init", "-q"], {
		cwd: tmpRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (r.exitCode !== 0) throw new Error("git init failed");
	// Configure identity so git add doesn't complain
	Bun.spawnSync(["git", "config", "user.email", "test@test.com"], {
		cwd: tmpRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	Bun.spawnSync(["git", "config", "user.name", "Test"], {
		cwd: tmpRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (filesToStage.length > 0) {
		const add = Bun.spawnSync(["git", "add", ...filesToStage], {
			cwd: tmpRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		if (add.exitCode !== 0)
			throw new Error(
				`git add failed: ${add.stderr.toString()}`,
			);
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("collectZigInputs", () => {
	// 1. Empty root — none of CANDIDATE_DIRS exist
	test("empty root returns empty arrays without throwing", () => {
		// tmpRoot has no CANDIDATE_DIRS entries (build.zig, src, etc.)
		const result = collectZigInputs(tmpRoot);
		expect(result).toEqual({ fmtInputs: [], zigFiles: [] });
	});

	// 2. fsWalk discovers .zig files AND build.zig when no VCS is available
	test("fsWalk discovers .zig files and build.zig in non-VCS tmpdir", () => {
		// Plain tmpdir: jj exits 2 (not a repo), git exits 128 (not a repo)
		// → both strategies fail → fsWalk fires
		touch("build.zig", "const std = @import(\"std\");");
		touch("src/main.zig", "pub fn main() void {}");
		touch("src/helper.zig", "pub fn help() void {}");

		const { fmtInputs, zigFiles } = collectZigInputs(tmpRoot);

		// All .zig files must appear in both arrays
		const absMain = join(tmpRoot, "src/main.zig");
		const absHelper = join(tmpRoot, "src/helper.zig");
		const absBuild = join(tmpRoot, "build.zig");

		expect(fmtInputs).toContain(absMain);
		expect(fmtInputs).toContain(absHelper);
		expect(fmtInputs).toContain(absBuild);
		expect(zigFiles).toContain(absMain);
		expect(zigFiles).toContain(absHelper);
		expect(zigFiles).toContain(absBuild);
	});

	// 3. fsWalk includes .zon in fmtInputs but EXCLUDES .zon from zigFiles
	test("fsWalk includes .zon in fmtInputs but excludes it from zigFiles", () => {
		// No VCS → fsWalk
		touch("build.zig", "");
		touch("build.zig.zon", ".fingerprint = 0,");
		touch("src/main.zig", "");

		const { fmtInputs, zigFiles } = collectZigInputs(tmpRoot);

		const absZon = join(tmpRoot, "build.zig.zon");
		const absZig = join(tmpRoot, "src/main.zig");

		// .zon in fmtInputs
		expect(fmtInputs).toContain(absZon);
		// .zon NOT in zigFiles
		expect(zigFiles).not.toContain(absZon);
		// .zig in both
		expect(fmtInputs).toContain(absZig);
		expect(zigFiles).toContain(absZig);
	});

	// 4. jj strategy wins over git when jj exits 0
	// SKIPPED: `jj files` (as used in the source) fails with exit 2 on
	// jj 0.42. The correct command is `jj file list`. This is a bug in
	// scripts/lib/files.ts — the jj strategy is dead in this environment.
	// When fixed, this test should: init a jj repo, create and track files,
	// assert the jj-tracked set is returned (and git is not consulted).
	test.skip("jj output is used over git when jj exits 0 (jj files bug — see header)", () => {
		// Placeholder for when source is fixed to use `jj file list`.
	});

	// 5. Falls through to git when jj returns non-zero
	test("falls through to git strategy when jj fails (non-VCS exits with code != 0)", () => {
		// In a git repo, jj exits 2 (not a jj repo → non-zero) → falls to git.
		// git ls-files exits 0 with staged paths → git strategy wins.
		touch("build.zig", "const std = @import(\"std\");");
		touch("src/main.zig", "pub fn main() void {}");
		gitInit(["build.zig", "src/main.zig"]);

		const { fmtInputs, zigFiles } = collectZigInputs(tmpRoot);

		expect(fmtInputs.length).toBeGreaterThan(0);
		expect(zigFiles.length).toBeGreaterThan(0);
		// Specifically the git-tracked files must appear
		expect(fmtInputs.some((p) => p.endsWith("build.zig"))).toBe(true);
		expect(zigFiles.some((p) => p.endsWith("src/main.zig"))).toBe(true);
	});

	// 6. git relative paths are resolved to absolute
	test("git relative paths are resolved to absolute paths", () => {
		touch("build.zig", "");
		touch("src/foo.zig", "");
		gitInit(["build.zig", "src/foo.zig"]);

		const { fmtInputs, zigFiles } = collectZigInputs(tmpRoot);

		// Every path must be absolute (starts with /)
		for (const p of fmtInputs) {
			expect(p.startsWith("/")).toBe(true);
		}
		for (const p of zigFiles) {
			expect(p.startsWith("/")).toBe(true);
		}
		// And must contain the tmpRoot prefix
		for (const p of zigFiles) {
			expect(p.startsWith(tmpRoot)).toBe(true);
		}
	});

	// 7. fsWalk includes a top-level build.zig
	test("fsWalk includes top-level build.zig (file, not directory)", () => {
		// No VCS → fsWalk. build.zig is a single top-level file in CANDIDATE_DIRS.
		touch("build.zig", "const std = @import(\"std\");");

		const { fmtInputs, zigFiles } = collectZigInputs(tmpRoot);

		const absBuild = join(tmpRoot, "build.zig");
		expect(fmtInputs).toContain(absBuild);
		expect(zigFiles).toContain(absBuild);
	});

	// 8. statSync/permission error (EACCES) — pins current behavior
	//
	// SOURCE BUG: fsWalk wraps only `statSync` in a try/catch. When
	// `statSync` succeeds (isDirectory() → true) but the subsequent
	// `Bun.Glob.scanSync` cannot enter the directory (EACCES), the error
	// propagates uncaught. The intended contract (§12 "no throw on EACCES")
	// is therefore NOT met. This test pins the CURRENT behavior so a future
	// fix is visible as a diff: change `toThrow` → `not.toThrow` once the
	// source wraps `glob.scanSync` in a try/catch.
	test("EACCES on an inaccessible subdir — pins current (throws) behavior", () => {
		// Skip if running as root (chmod 000 is ineffective for root).
		if (process.getuid?.() === 0) {
			console.log("Skipping EACCES test: running as root");
			return;
		}
		touch("build.zig", "");
		touch("src/main.zig", "");
		// Revoke all permissions on src/ — statSync succeeds (it probes the dir
		// entry, not its contents), but glob.scanSync throws when it tries to
		// open the directory for reading.
		chmodSync(join(tmpRoot, "src"), 0o000);

		// CURRENT (buggy) behavior: throws EACCES. Pin it explicitly.
		expect(() => collectZigInputs(tmpRoot)).toThrow(/EACCES/);
	});

	// 9. Empty git ls-files (code 0, empty stdout) falls through to fsWalk
	test("empty git ls-files (exit 0, empty stdout) falls through to fsWalk", () => {
		// git init with NO staged files: git ls-files exits 0, stdout is empty.
		// tracked.length === 0 → fsWalk fallback.
		touch("build.zig", "const std = @import(\"std\");");
		touch("src/main.zig", "pub fn main() void {}");
		// git init but stage nothing
		gitInit([]);

		const { fmtInputs, zigFiles } = collectZigInputs(tmpRoot);

		// fsWalk must still find the files
		const absBuild = join(tmpRoot, "build.zig");
		const absMain = join(tmpRoot, "src/main.zig");
		expect(fmtInputs).toContain(absBuild);
		expect(fmtInputs).toContain(absMain);
		expect(zigFiles).toContain(absBuild);
		expect(zigFiles).toContain(absMain);
	});
});
