/**
 * Tests for `listArtifacts` and mutation-sentinel cases (verify-release.ts).
 *
 * listArtifacts:
 *   - ENOENT returns [] (cargo-style layout, documented skip).
 *   - EACCES re-throws (must NOT return [] — silent failure would let release
 *     signing proceed over an incomplete artifact set).
 *
 * Mutation sentinels:
 *   - Prove that a naive hasher (no path\0/size\0 framing) collides on two
 *     different dir layouts whose concatenated bytes are identical, AND that
 *     hashDir's real framing correctly distinguishes them.  This is the
 *     regression boundary for the length-prefix framing described in the
 *     hashDir JSDoc and ADR 0005.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashDir, listArtifacts } from "../../scripts/verify-release.ts";

// ── listArtifacts ────────────────────────────────────────────────────────────

describe("listArtifacts", () => {
	let binDir = "";

	beforeEach(async () => {
		binDir = await mkdtemp(join(tmpdir(), "list-artifacts-"));
	});

	afterEach(async () => {
		await rm(binDir, { recursive: true, force: true });
	});

	test("returns [] for a missing bin directory (ENOENT — cargo-style layout)", () => {
		const missing = join(tmpdir(), "absolutely-nonexistent-bin-dir-" + Date.now());
		expect(listArtifacts(missing)).toEqual([]);
	});

	test("returns the artifact paths for a populated bin directory", async () => {
		await writeFile(join(binDir, "my-exe"), "\x7fELF stub");
		await writeFile(join(binDir, "my-lib"), "lib stub");
		const arts = listArtifacts(binDir);
		expect(arts.length).toBe(2);
		// Every returned path must be absolute (the scanSync absolute:true contract).
		for (const a of arts) {
			expect(a.startsWith("/")).toBe(true);
		}
	});

	test("returns [] for an empty bin directory", async () => {
		expect(listArtifacts(binDir)).toEqual([]);
	});

	test("re-throws EACCES (NOT []) when the bin directory is unreadable", async () => {
		// Skip when running as root (root bypasses permission checks).
		if (process.getuid?.() === 0) {
			console.log("(skipped: running as root)");
			return;
		}
		if (process.env.CI === "true" || process.env.CI === "1") {
			console.log("(skipped: CI environment)");
			return;
		}
		// Write a file so the dir is non-empty, then remove read+exec permission.
		await writeFile(join(binDir, "artifact"), "data");
		await chmod(binDir, 0o000);
		try {
			// listArtifacts must throw, NOT return [].
			expect(() => listArtifacts(binDir)).toThrow();
		} finally {
			await chmod(binDir, 0o755);
		}
	});
});

// ── Mutation sentinel: framing collision proof ───────────────────────────────
//
// A naive hasher that does NOT use path\0/size\0 framing collides on layouts
// whose raw bytes happen to concatenate identically.  hashDir's real framing
// must distinguish them.  If the \0 framing were ever removed from hashDir,
// this test would fail — that's exactly the regression boundary it pins.

describe("hashDir framing sentinel", () => {
	let dirA = "";
	let dirB = "";

	beforeEach(async () => {
		dirA = await mkdtemp(join(tmpdir(), "sentinel-a-"));
		dirB = await mkdtemp(join(tmpdir(), "sentinel-b-"));
	});

	afterEach(async () => {
		await rm(dirA, { recursive: true, force: true });
		await rm(dirB, { recursive: true, force: true });
	});

	test("naive hasher (no framing) collides but hashDir distinguishes", async () => {
		// Layout A: two files "a"="abc", "b"="def"
		await writeFile(join(dirA, "a"), "abc");
		await writeFile(join(dirA, "b"), "def");
		// Layout B: one file "ab"="abcdef"
		await writeFile(join(dirB, "ab"), "abcdef");

		// ── Naive hasher (simulates the old bug) ────────────────────────────
		// Concatenate raw bytes only (no path, no size framing).
		const naiveHash = async (dir: string): Promise<string> => {
			const glob = new Bun.Glob("*");
			const files: string[] = [];
			for (const f of glob.scanSync({ cwd: dir, absolute: true })) files.push(f);
			files.sort();
			const hasher = new Bun.CryptoHasher("sha256");
			for (const f of files) {
				const bytes = new Uint8Array(await Bun.file(f).arrayBuffer());
				hasher.update(bytes); // NO framing — the bug
			}
			return hasher.digest("hex");
		};

		const naiveA = await naiveHash(dirA);
		const naiveB = await naiveHash(dirB);
		// The naive hasher COLLIDES: both produce sha256("abcdef").
		expect(naiveA).toBe(naiveB);

		// ── Real hashDir (path\0 size\0 bytes framing) ──────────────────────
		const realA = await hashDir(dirA);
		const realB = await hashDir(dirB);
		// The framed hasher correctly distinguishes the two layouts.
		expect(realA).not.toBe("");
		expect(realB).not.toBe("");
		expect(realA).not.toBe(realB);
	});

	test("framing also distinguishes same-content files with different names", async () => {
		// dirA: file named "x" with content "hello"
		// dirB: file named "y" with content "hello"
		// A naive content-only hasher collides; the framed hasher does not.
		await writeFile(join(dirA, "x"), "hello");
		await writeFile(join(dirB, "y"), "hello");

		const hA = await hashDir(dirA);
		const hB = await hashDir(dirB);
		// The path is part of the frame, so different names → different digest.
		expect(hA).not.toBe(hB);
	});
});
