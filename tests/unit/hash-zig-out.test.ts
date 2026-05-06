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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
