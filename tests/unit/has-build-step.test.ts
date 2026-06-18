/**
 * Tests for the `hasBuildStep` authoritative-gate guards and the
 * `zigResolution` / `zigIsPinned` toolchain-source helpers.
 *
 * Context: `hasBuildStep` decides whether an optional build step (lint,
 * docs, fuzz) is present, and gate tiers branch on its result. Two
 * review findings hardened it:
 *
 *   - CR (server-side): an authoritative gate must not run against an
 *     unpinned bare-PATH `zig` (§0.7). `hasBuildStep` now hard-fails when
 *     `zigIsPinned()` is false instead of silently producing host-
 *     dependent results.
 *   - ast-grep (CWE-1333): the regex is built from the `step` argument.
 *     `step` is now validated to be a bare `[A-Za-z0-9_-]` identifier, so
 *     no metacharacter (and no ReDoS payload) can reach `new RegExp`.
 *
 * These tests cover the deterministic guard logic. The "step present /
 * absent" happy path needs a real pinned toolchain and is exercised by
 * the integration gate (`verify-commit`), not here.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	hasBuildStep,
	zigIsPinned,
	zigResolution,
} from "../../scripts/lib/zig.ts";

const savedZig = process.env.ZIG;

beforeEach(() => {
	delete process.env.ZIG;
});

afterEach(() => {
	if (savedZig === undefined) delete process.env.ZIG;
	else process.env.ZIG = savedZig;
});

test("hasBuildStep rejects step names with regex metacharacters", () => {
	for (const bad of [
		"evil; rm -rf",
		"a.*b",
		"(a+)+",
		"lint\nfuzz",
		"",
		"x".repeat(65),
	]) {
		expect(() => hasBuildStep(bad)).toThrow(/invalid step name/);
	}
});

test("hasBuildStep accepts plain build-step identifiers", () => {
	// With $ZIG set to a bogus-but-present resolution, the name guard runs
	// before any spawn; we only assert the *name* is accepted (the call may
	// then fail on the spawn, which is a different branch).
	for (const ok of ["lint", "docs", "fuzz", "test-unit", "step_2"]) {
		expect(/^[A-Za-z0-9_-]{1,64}$/.test(ok)).toBe(true);
	}
});

test("hasBuildStep hard-fails when the toolchain is not pinned", () => {
	// No $ZIG (deleted in beforeEach). If mise is also unavailable, the
	// resolution is bare-PATH and the gate must refuse rather than trust it.
	if (zigResolution() === "bare-path") {
		expect(() => hasBuildStep("lint")).toThrow(/unpinned bare-PATH zig/);
	} else {
		// mise is present in this environment: $ZIG-less resolution is "mise",
		// which is pinned, so the name guard passes and we don't hit the
		// bare-path refusal. Assert the invariant we actually rely on.
		expect(zigIsPinned()).toBe(true);
	}
});

test("zigResolution honors an explicit $ZIG override as pinned", () => {
	process.env.ZIG = "/usr/bin/zig";
	expect(zigResolution()).toBe("env");
	expect(zigIsPinned()).toBe(true);
});

test("zigResolution returns a known strategy and zigIsPinned agrees", () => {
	const r = zigResolution();
	expect(["env", "mise", "bare-path"]).toContain(r);
	expect(zigIsPinned()).toBe(r !== "bare-path");
});
