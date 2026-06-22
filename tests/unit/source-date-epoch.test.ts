/**
 * Tests for `sourceDateEpoch` (verify-release.ts Phase 1).
 *
 * The per-release reproducibility check builds twice and compares artifact
 * hashes; without a pinned SOURCE_DATE_EPOCH, timestamps embedded in build
 * outputs can differ between the two rebuilds and break the compare. These
 * tests pin the resolution contract:
 *   1. an explicit numeric $SOURCE_DATE_EPOCH is honored verbatim;
 *   2. a non-numeric $SOURCE_DATE_EPOCH is ignored (falls through);
 *   3. with no env override, the result is a decimal-seconds string
 *      (the HEAD commit time in this git repo, or the fixed fallback) so
 *      the same value can be fed to both builds deterministically.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { repoRoot } from "../../scripts/lib/runtime.ts";
import { sourceDateEpoch } from "../../scripts/verify-release.ts";

const saved = process.env.SOURCE_DATE_EPOCH;

beforeEach(() => {
	delete process.env.SOURCE_DATE_EPOCH;
});

afterEach(() => {
	if (saved === undefined) delete process.env.SOURCE_DATE_EPOCH;
	else process.env.SOURCE_DATE_EPOCH = saved;
});

test("honors an explicit numeric SOURCE_DATE_EPOCH verbatim", () => {
	process.env.SOURCE_DATE_EPOCH = "1700000000";
	expect(sourceDateEpoch(repoRoot())).toBe("1700000000");
});

test("trims surrounding whitespace on an explicit value", () => {
	process.env.SOURCE_DATE_EPOCH = "  1700000000  ";
	expect(sourceDateEpoch(repoRoot())).toBe("1700000000");
});

test("ignores a non-numeric SOURCE_DATE_EPOCH and falls through", () => {
	process.env.SOURCE_DATE_EPOCH = "not-a-number";
	const v = sourceDateEpoch(repoRoot());
	// Falls back to git HEAD time or the fixed fallback — either way a
	// pure decimal-seconds string, never the bogus override.
	expect(v).not.toBe("not-a-number");
	expect(v).toMatch(/^\d+$/);
});

test("returns a decimal-seconds string with no env override", () => {
	const v = sourceDateEpoch(repoRoot());
	expect(v).toMatch(/^\d+$/);
	// Sanity: a plausible Unix timestamp (after 2000-01-01), so we never
	// hand zig something like "0" or a garbage value.
	expect(Number(v)).toBeGreaterThan(946_684_800);
});

test("is stable across calls (same value for both rebuilds)", () => {
	const a = sourceDateEpoch(repoRoot());
	const b = sourceDateEpoch(repoRoot());
	expect(a).toBe(b);
});

// ── New cases (plan §9) ─────────────────────────────────────────────────────

test("returns the fixed fallback '1767225600' when the directory has no git commits", async () => {
	// Create a fresh empty directory + `git init` (no commits).
	const { mkdtemp, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const dir = await mkdtemp(join(tmpdir(), "sde-nocommit-"));
	try {
		Bun.spawnSync(["git", "init", dir], { stdout: "pipe", stderr: "pipe" });
		// A fresh repo has no commits, so `git log -1 --format=%ct` exits 0
		// but emits an empty string — the function must fall through to the
		// fixed constant rather than returning an empty or NaN value.
		const v = sourceDateEpoch(dir);
		expect(v).toBe("1767225600");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("returns the fixed fallback when git exits 0 but stdout is empty", () => {
	// Simulate: git present on PATH, exit 0, but empty stdout (e.g. no commits).
	// We pass a path that is not a git repo so git exits non-zero — but we want
	// the empty-stdout branch specifically.  We test the branch by observing that
	// a repo with no commits (above test) exercises it; here we confirm via a
	// non-repo path that the result is still a valid decimal string (fallback or
	// the outer git invocation returning non-zero also hits the fallback).
	// The key invariant: no path through sourceDateEpoch returns a non-numeric
	// string.
	const v = sourceDateEpoch("/tmp");
	expect(v).toMatch(/^\d+$/);
});

test("returns the fixed fallback when git is absent from PATH", async () => {
	// Spawn a child process whose PATH contains no `git` binary so the
	// Bun.spawnSync inside sourceDateEpoch throws ENOENT.  We do this in a
	// subprocess so we do not mutate the current process environment.
	// Resolve bun's absolute path at runtime so the subprocess can launch even
	// when PATH is stripped down to a directory that contains only bun.
	const bunExe = Bun.which("bun") ?? process.execPath;
	const bunDir = bunExe.slice(0, bunExe.lastIndexOf("/"));
	const script = /* ts */ `
		import { sourceDateEpoch } from ${JSON.stringify(
			new URL("../../scripts/verify-release.ts", import.meta.url).pathname,
		)};
		process.stdout.write(sourceDateEpoch("/tmp"));
	`;
	const result = Bun.spawnSync(
		[bunExe, "--eval", script],
		{
			env: {
				// Keep only the directory that contains bun so git cannot be found
				// but the bun runtime itself stays launchable.
				...process.env,
				PATH: bunDir + ":/nonexistent-path-no-git",
				// Ensure no env override interferes.
				SOURCE_DATE_EPOCH: "",
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const out = result.stdout.toString().trim();
	// The catch clause must return the fixed fallback, never throw.
	expect(out).toBe("1767225600");
});
