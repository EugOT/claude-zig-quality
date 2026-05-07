/**
 * Test 2.4 — `emitDriftDiff` finally-block cleanup never throws.
 *
 * Pre-fix: the finally block ran two `await rm(..., { force: true })`
 * calls in sequence. `force: true` swallows ENOENT but not EACCES /
 * EPERM / EBUSY (e.g. on Windows when an antivirus has the temp file
 * open). When the first `rm` threw, the second never ran and the
 * thrown error masked the caller's intended `finish(1, ...)` exit.
 *
 * Post-fix: cleanup uses `Promise.allSettled` so both `rm` calls
 * always complete and any rejection is collected, never re-thrown.
 *
 * This test stubs `rm` to always reject and asserts `emitDriftDiff`
 * resolves successfully.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitDriftDiff } from "../../scripts/check-public-api.ts";

let tmpRoot = "";

beforeEach(async () => {
	tmpRoot = await mkdtemp(join(tmpdir(), "public-api-cleanup-"));
});

afterEach(async () => {
	await rm(tmpRoot, { recursive: true, force: true });
});

test("emitDriftDiff swallows cleanup errors instead of masking finish()", async () => {
	let calls = 0;
	const failingRm = async (
		_path: string,
		_opts: { force: true },
	): Promise<void> => {
		calls += 1;
		throw new Error("simulated EACCES from antivirus / locked tmp");
	};

	// The fixed implementation must:
	//   (a) resolve cleanly even though both rm calls reject, and
	//   (b) still attempt cleanup for both temp files (allSettled).
	await expect(
		emitDriftDiff(tmpRoot, "old-surface", "new-surface", failingRm),
	).resolves.toBeUndefined();

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
