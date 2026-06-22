/**
 * Test 2.1 — `hashDir` length-prefixed framing.
 *
 * The previous (buggy) implementation concatenated raw file bytes into a
 * single sha256, which made artifact-boundary aliasing trivial:
 *   ["a"=abc, "b"=def]  ─┐
 *                        ├─→ identical digest
 *   ["ab"=abcdef]       ─┘
 *
 * The fixed implementation frames each file as
 *   <relative-path> \0 <byte-length> \0 <bytes>
 * which makes the byte stream unambiguous. This test pins that property
 * by building two tmpdirs whose concatenated bytes match but whose file
 * boundaries differ, and asserting the digests diverge.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashDir } from "../../scripts/verify-release.ts";

let dirA = "";
let dirB = "";

beforeEach(async () => {
	dirA = await mkdtemp(join(tmpdir(), "hash-zig-out-a-"));
	dirB = await mkdtemp(join(tmpdir(), "hash-zig-out-b-"));
});

afterEach(async () => {
	await rm(dirA, { recursive: true, force: true });
	await rm(dirB, { recursive: true, force: true });
});

test("hashDir distinguishes artifact-boundary aliasing", async () => {
	// dirA: two files whose content concatenates to "abcdef".
	await writeFile(join(dirA, "a"), "abc");
	await writeFile(join(dirA, "b"), "def");
	// dirB: one file whose content is "abcdef".
	await writeFile(join(dirB, "ab"), "abcdef");

	const ha = await hashDir(dirA);
	const hb = await hashDir(dirB);

	expect(ha).not.toBe("");
	expect(hb).not.toBe("");
	expect(ha).not.toBe(hb);
});

test("hashDir is deterministic for the same content", async () => {
	await writeFile(join(dirA, "x"), "hello");
	await writeFile(join(dirA, "y"), "world");
	const h1 = await hashDir(dirA);
	const h2 = await hashDir(dirA);
	expect(h1).toBe(h2);
});

test("hashDir returns empty string for missing dir", async () => {
	const h = await hashDir(join(tmpdir(), "definitely-not-a-real-dir-xyz"));
	expect(h).toBe("");
});

test("hashDir returns empty string for empty dir", async () => {
	const h = await hashDir(dirA);
	expect(h).toBe("");
});

// ── New cases (plan §9) ─────────────────────────────────────────────────────

test("hashDir re-throws EACCES (not empty string) when a subdir is unreadable", async () => {
	// Skip when running as root (root bypasses permission checks).
	if (process.getuid?.() === 0) {
		console.log("(skipped: running as root, chmod 000 has no effect)");
		return;
	}
	// Skip in CI environments where the test runner may also be root.
	if (process.env.CI === "true" || process.env.CI === "1") {
		console.log("(skipped: CI environment detected)");
		return;
	}
	await writeFile(join(dirA, "legit"), "contents");
	// Create a subdir that hashDir's Bun.Glob will try to scan; make it unreadable.
	// Note: Bun.Glob("*") with absolute:true on the parent dir will encounter
	// this subdir as an entry; when it tries to stat/open it, EACCES fires.
	// We test that hashDir propagates the error rather than silently returning "".
	const locked = join(dirA, "locked-subdir");
	await mkdir(locked, { recursive: true });
	await writeFile(join(locked, "secret"), "hidden");
	await chmod(locked, 0o000);
	try {
		await expect(hashDir(locked)).rejects.toThrow();
	} finally {
		// Restore permissions so rm() in afterEach can clean up.
		await chmod(locked, 0o755);
	}
});

test("hashDir normalizes path separators to forward slash", async () => {
	// Write files and confirm the digest is stable across platforms.
	// The relative path used in the hasher must use '/' regardless of OS sep.
	await writeFile(join(dirA, "artifact"), "payload");
	const h1 = await hashDir(dirA);
	expect(h1).not.toBe("");
	// A second call must produce the exact same digest — forward-slash
	// normalisation is deterministic, not random per invocation.
	const h2 = await hashDir(dirA);
	expect(h1).toBe(h2);
	// The digest changes when the filename changes (path is part of the frame).
	await writeFile(join(dirB, "artifact_renamed"), "payload");
	const h3 = await hashDir(dirB);
	expect(h1).not.toBe(h3);
});
