/**
 * Unit tests for compareHashes extracted from scripts/verify-release.ts.
 * The signing and SBOM hardening helpers are covered by release-hardening.test.ts.
 * compareHashes keeps the one-sided empty-artifact regression pinned
 *
 * All helpers are pure (no I/O, no process.env mutation at test boundaries)
 * so no setup/teardown is needed.
 */

import { describe, expect, test } from "bun:test";
import { compareHashes } from "../../scripts/verify-release.ts";

// ---------------------------------------------------------------------------
// compareHashes — match | mismatch | empty
// ---------------------------------------------------------------------------

describe("compareHashes", () => {
	test("returns 'match' for identical non-empty hashes", () => {
		const h = "abc123def456";
		expect(compareHashes(h, h)).toBe("match");
	});

	test("returns 'mismatch' for different non-empty hashes", () => {
		expect(compareHashes("aaa", "bbb")).toBe("mismatch");
	});

	test("returns 'empty' when both hashes are empty strings", () => {
		expect(compareHashes("", "")).toBe("empty");
	});

	test("returns 'mismatch' when only first hash is empty", () => {
		expect(compareHashes("", "abc")).toBe("mismatch");
	});

	test("returns 'mismatch' when only second hash is empty", () => {
		expect(compareHashes("abc", "")).toBe("mismatch");
	});

	// Verify the mapping main() relies on: empty and match → no failure;
	// mismatch → failure. We test at the helper level (main decides exit code).
	test("'match' verdict does NOT indicate a failure condition", () => {
		expect(compareHashes("deadbeef", "deadbeef")).not.toBe("mismatch");
	});

	test("'empty' verdict does NOT indicate a failure condition", () => {
		expect(compareHashes("", "")).not.toBe("mismatch");
	});

	test("'mismatch' verdict indicates the failure condition", () => {
		expect(compareHashes("hash1", "hash2")).toBe("mismatch");
	});
});
