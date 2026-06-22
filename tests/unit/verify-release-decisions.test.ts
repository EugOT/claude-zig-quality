/**
 * Unit tests for the four pure decision functions extracted from
 * scripts/verify-release.ts main():
 *   - signingEnvError   (triple gate: COSIGN_ENABLED + CI + hasCosign)
 *   - signingArgs       (exact cosign sign-blob argv)
 *   - validateSbom      (zig | syft | skip)
 *   - compareHashes     (match | mismatch | empty)
 *
 * All helpers are pure (no I/O, no process.env mutation at test boundaries)
 * so no setup/teardown is needed.
 */

import { describe, expect, test } from "bun:test";
import {
	compareHashes,
	signingArgs,
	signingEnvError,
	validateSbom,
} from "../../scripts/verify-release.ts";

// ---------------------------------------------------------------------------
// signingEnvError — triple gate
// ---------------------------------------------------------------------------

describe("signingEnvError", () => {
	// All three gates pass → proceed (null)
	test("returns null when COSIGN_ENABLED=1, CI=true, hasCosign=true", () => {
		expect(
			signingEnvError({ COSIGN_ENABLED: "1", CI: "true" }, true),
		).toBeNull();
	});

	test("returns null when COSIGN_ENABLED=1, CI=1, hasCosign=true", () => {
		expect(
			signingEnvError({ COSIGN_ENABLED: "1", CI: "1" }, true),
		).toBeNull();
	});

	// COSIGN_ENABLED gate
	test("returns reason string when COSIGN_ENABLED is missing", () => {
		const result = signingEnvError({ CI: "true" }, true);
		expect(typeof result).toBe("string");
		expect(result!.length).toBeGreaterThan(0);
	});

	test("returns reason string when COSIGN_ENABLED='0'", () => {
		expect(
			signingEnvError({ COSIGN_ENABLED: "0", CI: "true" }, true),
		).not.toBeNull();
	});

	test("returns reason string when COSIGN_ENABLED='true' (not literally '1')", () => {
		expect(
			signingEnvError({ COSIGN_ENABLED: "true", CI: "true" }, true),
		).not.toBeNull();
	});

	// CI gate
	test("returns reason string when CI is undefined", () => {
		expect(
			signingEnvError({ COSIGN_ENABLED: "1" }, true),
		).not.toBeNull();
	});

	test("returns reason string when CI='false'", () => {
		expect(
			signingEnvError({ COSIGN_ENABLED: "1", CI: "false" }, true),
		).not.toBeNull();
	});

	test("returns reason string when CI='yes'", () => {
		expect(
			signingEnvError({ COSIGN_ENABLED: "1", CI: "yes" }, true),
		).not.toBeNull();
	});

	test("returns reason string when CI='0'", () => {
		expect(
			signingEnvError({ COSIGN_ENABLED: "1", CI: "0" }, true),
		).not.toBeNull();
	});

	// hasCosign gate
	test("returns reason string when hasCosign=false even if env is fully configured", () => {
		expect(
			signingEnvError({ COSIGN_ENABLED: "1", CI: "true" }, false),
		).not.toBeNull();
	});

	test("returns reason string when hasCosign=false with CI='1'", () => {
		expect(
			signingEnvError({ COSIGN_ENABLED: "1", CI: "1" }, false),
		).not.toBeNull();
	});
});

// ---------------------------------------------------------------------------
// signingArgs — exact cosign sign-blob argv
// ---------------------------------------------------------------------------

describe("signingArgs", () => {
	test("returns exact argv array for a simple artifact path", () => {
		const artifact = "/tmp/zig-out/bin/myapp";
		expect(signingArgs(artifact)).toEqual([
			"cosign",
			"sign-blob",
			"--yes",
			"--output-signature",
			`${artifact}.sig`,
			artifact,
		]);
	});

	test("sig sidecar path is artifact + '.sig'", () => {
		const artifact = "/release/mylib";
		const argv = signingArgs(artifact);
		const sigIdx = argv.indexOf("--output-signature");
		expect(sigIdx).not.toBe(-1);
		expect(argv[sigIdx + 1]).toBe(`${artifact}.sig`);
	});

	test("artifact itself is the last element", () => {
		const artifact = "/some/path/exe";
		const argv = signingArgs(artifact);
		expect(argv[argv.length - 1]).toBe(artifact);
	});

	test("includes --yes flag (keyless / non-interactive)", () => {
		expect(signingArgs("/a/b")).toContain("--yes");
	});
});

// ---------------------------------------------------------------------------
// validateSbom — zig | syft | skip
// ---------------------------------------------------------------------------

describe("validateSbom", () => {
	test("returns 'zig' when script exists (regardless of syft)", () => {
		expect(validateSbom(true, true)).toBe("zig");
		expect(validateSbom(true, false)).toBe("zig");
	});

	test("returns 'syft' when script missing but syft available", () => {
		expect(validateSbom(false, true)).toBe("syft");
	});

	test("returns 'skip' when neither script nor syft is available", () => {
		expect(validateSbom(false, false)).toBe("skip");
	});
});

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
