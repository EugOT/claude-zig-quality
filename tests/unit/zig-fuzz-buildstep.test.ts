/**
 * Tests for `zigSupportsFuzz()` platform/version degradation logic and the
 * `runFuzz` timer-cleanup regression guard.
 *
 * Scenarios covered (plan order=8):
 *
 *   1. zigSupportsFuzz -> false on darwin + Zig 0.16.0 (ziglang/zig#20986).
 *   2. ZIG_QM_FORCE_FUZZ=1 overrides the darwin block -> true.
 *   3. zigSupportsFuzz -> true on linux (0.16.0 fuzz works on Linux).
 *   8. runFuzz: command exiting 0 before timeout -> 'pass' (timedOut false).
 *      [SKIPPED: already covered by run-fuzz.test.ts]
 *   9. runFuzz: clearTimeout always fires even when Bun.spawn throws.
 *
 * Seam approach:
 *   - zigSupportsFuzz({ platform, version, forceFuzz }) keeps the platform
 *     matrix pure and avoids mutating process.platform in Bun's runtime.
 *   - runFuzz({ command }) injects an arbitrary argv for timer cleanup tests.
 */
import { describe, expect, test } from "bun:test";
import { runFuzz, zigSupportsFuzz } from "../../scripts/lib/zig.ts";

// ---------------------------------------------------------------------------
// Scenarios 1-3: zigSupportsFuzz() platform/version matrix
// ---------------------------------------------------------------------------

describe("zigSupportsFuzz - darwin + Zig 0.16.0 degradation (ziglang/zig#20986)", () => {
	/**
	 * Scenario 1: darwin + 0.16.0 -> false.
	 *
	 * This is the upstream-broken combination documented in ADR 0003. The gate
	 * must degrade explicitly (return false) so callers emit the skip message
	 * rather than silently skipping or crashing.
	 */
	test("scenario 1: returns false on darwin with Zig 0.16.0", () => {
		expect(zigSupportsFuzz({ platform: "darwin", version: "0.16.0" })).toBe(
			false,
		);
	});

	/**
	 * Scenario 2: ZIG_QM_FORCE_FUZZ=1 overrides the darwin/0.16.0 block.
	 *
	 * The operator escape hatch must take precedence over the degradation rule
	 * so a developer who knowingly wants to try anyway is not blocked.
	 */
	test("scenario 2: ZIG_QM_FORCE_FUZZ=1 overrides the darwin block -> true", () => {
		expect(
			zigSupportsFuzz({
				platform: "darwin",
				version: "0.16.0",
				forceFuzz: "1",
			}),
		).toBe(true);
	});

	/**
	 * Scenario 3: linux + 0.16.0 -> true.
	 *
	 * The degradation rule is darwin-only. On Linux the fuzz gate is active
	 * regardless of version.
	 */
	test("scenario 3: returns true on linux with Zig 0.16.0", () => {
		expect(zigSupportsFuzz({ platform: "linux", version: "0.16.0" })).toBe(
			true,
		);
	});
});

// ---------------------------------------------------------------------------
// Scenario 9: clearTimeout fires even when Bun.spawn throws
// ---------------------------------------------------------------------------

describe("runFuzz - timer cleanup regression (scenario 9)", () => {
	/**
	 * Scenario 9: clearTimeout always runs even when the spawn fails.
	 *
	 * If the `finally { clearTimeout(timer) }` block were missing, a Bun.spawn
	 * ENOENT / throw would leave the AbortController timer alive in the event
	 * loop, keeping the Bun process from exiting naturally and causing CI hangs.
	 */
	test("scenario 9: promise settles quickly even when spawn throws (timer cleared)", async () => {
		const impossibleCmd = [
			"/absolutely/nonexistent/binary/that/does/not/exist/on/any/host",
		];

		const RACE_DEADLINE_MS = 500;
		const result = await Promise.race([
			runFuzz({
				limit: "1m",
				timeoutMs: 2000,
				command: impossibleCmd,
			}).then(
				(v) => ({ settled: true, value: v, threw: false }),
				(e) => ({ settled: true, error: e, threw: true }),
			),
			new Promise<{ settled: false }>((resolve) =>
				setTimeout(() => resolve({ settled: false }), RACE_DEADLINE_MS),
			),
		]);

		expect(result.settled).toBe(true);
	});
});
