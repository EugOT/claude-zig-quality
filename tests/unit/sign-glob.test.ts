/**
 * Test 2.2 — cosign signing skips cleanly when zig-out/bin is absent.
 *
 * Before the fix, `Bun.Glob.scanSync` was called in the cosign branch
 * without try/catch even though the same pattern in `hashZigOut` was
 * wrapped. On a project that does not produce a `zig-out/bin/` (e.g.
 * a cargo-style or pure-library layout), this aborted signing with an
 * uncaught throw instead of skipping.
 *
 * The fix factors out `listArtifacts(bin)` which mirrors `hashDir`'s
 * crash-tolerance: a missing or unreadable directory yields `[]`, and
 * the caller decides to log "no artifacts found, skipping signing".
 */

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listArtifacts } from "../../scripts/verify-release.ts";

test("listArtifacts returns [] for missing directory (no throw)", () => {
	const out = listArtifacts(join(tmpdir(), "no-such-zig-out-bin-xyz"));
	expect(out).toEqual([]);
});

test("listArtifacts returns [] for empty directory", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sign-glob-empty-"));
	try {
		const out = listArtifacts(dir);
		expect(out).toEqual([]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("listArtifacts returns absolute file paths when populated", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sign-glob-pop-"));
	try {
		await writeFile(join(dir, "alpha"), "x");
		await writeFile(join(dir, "beta"), "y");
		const out = listArtifacts(dir).sort();
		expect(out).toHaveLength(2);
		expect(out[0]).toBe(join(dir, "alpha"));
		expect(out[1]).toBe(join(dir, "beta"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

/**
 * R7-4 (CR Major): pin Bun.Glob's `"*"` semantics. The `zig-out/bin/`
 * layout that `verify-release` signs is flat — no nested subdirs — and
 * the glob pattern intentionally does NOT recurse. If a future Bun
 * release changes `"*"` to also match nested files, this test fires
 * and the caller's contract docstring must be revisited.
 */
test("listArtifacts does NOT recurse into subdirectories (pattern '*' is top-level only)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sign-glob-subdir-"));
	try {
		// top-level files: should be returned
		await writeFile(join(dir, "top1"), "a");
		await writeFile(join(dir, "top2"), "b");
		// nested file: must NOT be returned by `"*"` semantics
		const sub = join(dir, "subdir");
		await mkdir(sub, { recursive: true });
		await writeFile(join(sub, "nested"), "c");

		const out = listArtifacts(dir).sort();
		// only the two top-level files (or, if Bun yields the subdir
		// entry as a directory path, it would still not match "nested")
		const justFileNames = out.map((p) => p.split("/").pop()).sort();
		expect(justFileNames).not.toContain("nested");
		expect(justFileNames).toContain("top1");
		expect(justFileNames).toContain("top2");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
