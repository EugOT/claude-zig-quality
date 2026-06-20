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
