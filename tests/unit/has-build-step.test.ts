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
 *
 * Extended scenarios (plan order=8):
 *   4. regex matches a step with trailing whitespace/tab in synthetic listing
 *   5. returns false for a step absent from the listing
 *   6. THROWS (not false) when `zig build -l` exits non-zero (invisible-gate
 *      regression: a build error must not be silently read as "step absent")
 *   7. boundary: 64-char step name accepted; 65-char rejected
 */
import { chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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

test("hasBuildStep accepts plain build-step identifiers (no name rejection)", () => {
	// Force the pinned "env" strategy with a bogus $ZIG so zigIsPinned() is
	// true and the name guard runs, but the subsequent `zig build -l` spawn
	// fails fast. We assert the function does NOT reject the name — the only
	// error it may raise here is the downstream spawn/exec failure, never
	// `invalid step name`. This exercises the actual hasBuildStep code path
	// (not just the regex literal), closing the tautology a pure regex
	// assertion would leave (CodeRabbit finding).
	process.env.ZIG = "/nonexistent/pinned/zig";
	for (const ok of ["lint", "docs", "fuzz", "test-unit", "step_2"]) {
		let rejectedName = false;
		try {
			hasBuildStep(ok);
		} catch (e) {
			if (/invalid step name/.test((e as Error).message)) rejectedName = true;
		}
		expect(rejectedName).toBe(false);
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

// ---------------------------------------------------------------------------
// Scenario 4 — regex matches step with trailing whitespace / tab in listing
// Scenario 5 — returns false for a step absent from the listing
// Scenario 6 — THROWS when `zig build -l` exits non-zero
// Scenario 7 — 64-char step name accepted; 65-char step name rejected
// ---------------------------------------------------------------------------

/**
 * Helper: write a tiny shell script to `path`, make it executable, and
 * set $ZIG to point at it so `hasBuildStep` uses the fake binary instead
 * of the real Zig toolchain.
 */
function makeFakeZig(path: string, body: string): void {
	writeFileSync(path, `#!/bin/sh\n${body}\n`);
	chmodSync(path, 0o755);
}

describe("hasBuildStep with synthetic `zig build -l` listing", () => {
	// These tests need a pinned-looking ZIG so the §0.7 guard passes.
	// We point $ZIG at a tiny shell script that emits a known listing.

	const fakeZigBase = join(tmpdir(), "claude-zig-quality-fake-zig");

	test("scenario 4: matches a step whose listing line has trailing whitespace/tab", () => {
		// The regex is `^[\t ]*<step>(?:\s|$)` in multiline mode — it must
		// accept both trailing spaces and trailing tabs after the step name.
		const scriptPath = `${fakeZigBase}-listing`;
		// Emit a `zig build -l`-style block with mixed trailing whitespace.
		makeFakeZig(
			scriptPath,
			// Two lines: one with trailing spaces, one with trailing tab.
			'echo "  lint  \n  fuzz\t"',
		);
		process.env.ZIG = scriptPath;
		expect(hasBuildStep("lint")).toBe(true);
		expect(hasBuildStep("fuzz")).toBe(true);
	});

	test("scenario 5: returns false for a step absent from the listing", () => {
		const scriptPath = `${fakeZigBase}-absent`;
		makeFakeZig(scriptPath, 'echo "  lint\n  docs\n"');
		process.env.ZIG = scriptPath;
		expect(hasBuildStep("fuzz")).toBe(false);
		expect(hasBuildStep("nonexistent-step")).toBe(false);
	});

	test("scenario 6: THROWS (not false) when `zig build -l` exits non-zero", () => {
		// Regression guard: a build-system error must never be silently read
		// as "step absent" and cause the gate to be skipped invisibly.
		const scriptPath = `${fakeZigBase}-fail`;
		makeFakeZig(scriptPath, "exit 1");
		process.env.ZIG = scriptPath;
		expect(() => hasBuildStep("lint")).toThrow(
			/refusing to silently skip the gate/,
		);
	});
});

describe("hasBuildStep step-name length boundary (scenario 7)", () => {
	// The source validates: /^[A-Za-z0-9_-]{1,64}$/ — so 64 chars is the
	// maximum valid length and 65 chars must be rejected.

	test("accepts a step name exactly 64 characters long", () => {
		// With a non-existent $ZIG the name guard runs first; to isolate the
		// length boundary we only care that `invalid step name` is NOT thrown.
		// A subsequent spawn failure (ENOENT on /nonexistent/zig) is fine.
		process.env.ZIG = "/nonexistent/pinned-zig-for-boundary-test";
		const name64 = "a".repeat(64);
		let rejectedName = false;
		try {
			hasBuildStep(name64);
		} catch (e) {
			if (/invalid step name/.test((e as Error).message)) rejectedName = true;
		}
		expect(rejectedName).toBe(false);
	});

	test("rejects a step name 65 characters long", () => {
		process.env.ZIG = "/nonexistent/pinned-zig-for-boundary-test";
		const name65 = "a".repeat(65);
		expect(() => hasBuildStep(name65)).toThrow(/invalid step name/);
	});
});
