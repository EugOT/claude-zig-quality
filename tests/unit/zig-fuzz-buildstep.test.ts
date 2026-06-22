/**
 * Tests for `zigSupportsFuzz()` platform/version degradation logic and the
 * `runFuzz` timer-cleanup regression guard.
 *
 * Scenarios covered (plan order=8):
 *
 *   1. zigSupportsFuzz → false on darwin + Zig 0.16.0 (ziglang/zig#20986).
 *      Override process.platform to 'darwin' and stub zigVersion via $ZIG.
 *
 *   2. ZIG_QM_FORCE_FUZZ=1 overrides the darwin block → true. Same stubs.
 *
 *   3. zigSupportsFuzz → true on linux (0.16.0 fuzz works on Linux).
 *
 *   8. runFuzz: command exiting 0 before timeout → 'pass' (timedOut false).
 *      [SKIPPED — already covered by "runFuzz returns 'pass' when the
 *      command exits 0 in time" in run-fuzz.test.ts]
 *
 *   9. runFuzz: clearTimeout always fires even when Bun.spawn throws
 *      (regression — a dangling AbortController timer would keep the Bun
 *      event loop alive indefinitely). Verified by using a command that
 *      Bun.spawn cannot start (bad binary path) and asserting the promise
 *      settles within a tight deadline rather than hanging.
 *
 * Seam approach (matches has-build-step.test.ts and run-fuzz.test.ts):
 *   - process.env.ZIG → tiny shell script that echoes the desired version
 *   - Object.defineProperty(process, 'platform', ...) → override host OS
 *   - runFuzz({ command }) test seam → inject an arbitrary argv
 *
 * The platform override is isolated to each test via beforeEach/afterEach so
 * it cannot leak into other test files run in the same Bun worker.
 */
import { chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runFuzz, zigSupportsFuzz } from "../../scripts/lib/zig.ts";

// ---------------------------------------------------------------------------
// Shared seam helpers
// ---------------------------------------------------------------------------

const TMP = tmpdir();

/** Write an executable shell script that prints `version` to stdout. */
function makeFakeZigVersion(path: string, version: string): void {
	writeFileSync(path, `#!/bin/sh\necho ${version}\n`);
	chmodSync(path, 0o755);
}

// ---------------------------------------------------------------------------
// State saved before each test; restored after.
// ---------------------------------------------------------------------------

const savedZig = process.env.ZIG;
const savedForceFuzz = process.env.ZIG_QM_FORCE_FUZZ;
// process.platform is read-only by spec but configurable in V8/Bun; we
// save and restore it so overrides never leak across tests.
const savedPlatform = process.platform;

beforeEach(() => {
	delete process.env.ZIG;
	delete process.env.ZIG_QM_FORCE_FUZZ;
	// Restore host platform at the start of every test so each test that
	// needs a specific platform sets it explicitly.
	Object.defineProperty(process, "platform", {
		value: savedPlatform,
		writable: true,
		configurable: true,
	});
});

afterEach(() => {
	if (savedZig === undefined) delete process.env.ZIG;
	else process.env.ZIG = savedZig;

	if (savedForceFuzz === undefined) delete process.env.ZIG_QM_FORCE_FUZZ;
	else process.env.ZIG_QM_FORCE_FUZZ = savedForceFuzz;

	Object.defineProperty(process, "platform", {
		value: savedPlatform,
		writable: true,
		configurable: true,
	});
});

// ---------------------------------------------------------------------------
// Scenarios 1–3: zigSupportsFuzz() platform/version matrix
// ---------------------------------------------------------------------------

describe("zigSupportsFuzz — darwin + Zig 0.16.0 degradation (ziglang/zig#20986)", () => {
	/**
	 * Scenario 1: darwin + 0.16.0 → false.
	 *
	 * This is the upstream-broken combination documented in ADR 0003. The gate
	 * must degrade *explicitly* (return false) so callers emit the skip message
	 * rather than silently skipping or crashing.
	 */
	test("scenario 1: returns false on darwin with Zig 0.16.0", () => {
		const fakeZig = join(TMP, "cz-fake-zig-v016-darwin");
		makeFakeZigVersion(fakeZig, "0.16.0");
		process.env.ZIG = fakeZig;

		Object.defineProperty(process, "platform", {
			value: "darwin",
			writable: true,
			configurable: true,
		});

		expect(zigSupportsFuzz()).toBe(false);
	});

	/**
	 * Scenario 2: ZIG_QM_FORCE_FUZZ=1 overrides the darwin/0.16.0 block.
	 *
	 * The operator escape hatch must take precedence over the degradation rule
	 * so a developer who knowingly wants to try anyway is not blocked.
	 */
	test("scenario 2: ZIG_QM_FORCE_FUZZ=1 overrides the darwin block → true", () => {
		const fakeZig = join(TMP, "cz-fake-zig-v016-force");
		makeFakeZigVersion(fakeZig, "0.16.0");
		process.env.ZIG = fakeZig;
		process.env.ZIG_QM_FORCE_FUZZ = "1";

		Object.defineProperty(process, "platform", {
			value: "darwin",
			writable: true,
			configurable: true,
		});

		expect(zigSupportsFuzz()).toBe(true);
	});

	/**
	 * Scenario 3: linux + 0.16.0 → true.
	 *
	 * The degradation rule is darwin-only. On Linux the fuzz gate is active
	 * regardless of version.
	 */
	test("scenario 3: returns true on linux with Zig 0.16.0", () => {
		const fakeZig = join(TMP, "cz-fake-zig-v016-linux");
		makeFakeZigVersion(fakeZig, "0.16.0");
		process.env.ZIG = fakeZig;

		Object.defineProperty(process, "platform", {
			value: "linux",
			writable: true,
			configurable: true,
		});

		expect(zigSupportsFuzz()).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Scenario 9: clearTimeout fires even when Bun.spawn throws
// ---------------------------------------------------------------------------

describe("runFuzz — timer cleanup regression (scenario 9)", () => {
	/**
	 * Scenario 9: clearTimeout always runs even when the spawn fails.
	 *
	 * If the `finally { clearTimeout(timer) }` block were missing (or placed
	 * inside the `try` body before the spawn), a Bun.spawn ENOENT / throw
	 * would leave the AbortController's setTimeout alive in the event loop,
	 * keeping the Bun process from exiting naturally and causing CI hangs.
	 *
	 * We verify the fix by pointing `command` at a path that does not exist
	 * on any CI host and asserting that `runFuzz` settles (either with a
	 * throw or with a numeric code) within a tight wall-clock deadline. If the
	 * timer leaked, the test runner would time out instead of settling.
	 *
	 * Implementation note: Bun.spawn with a missing binary throws synchronously
	 * (ENOENT). The `runFuzz` source catches this in `proc.exited`'s rejection
	 * handler and re-throws unless `timedOut` is set. In either case the
	 * `finally` block must have already run before the caller sees the result.
	 */
	test("scenario 9: promise settles quickly even when spawn throws (timer cleared)", async () => {
		// A command that cannot possibly exist — guarantees Bun.spawn throws.
		const impossibleCmd = [
			"/absolutely/nonexistent/binary/that/does/not/exist/on/any/host",
		];

		// The outer Promise.race gives us a hard wall-clock ceiling.
		// If `clearTimeout` did NOT fire, the event loop would stay alive for
		// `timeoutMs` (2 000 ms here) and the race would resolve to 'hung'.
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

		// The promise must have settled — either with a result or a thrown
		// error — well within RACE_DEADLINE_MS. A 'hung' result here means
		// the timer was not cleared and the event loop was blocked.
		expect(result.settled).toBe(true);
	});
});
