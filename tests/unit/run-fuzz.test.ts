/**
 * Test 2.3 — `runFuzz` correctly returns "timeout" when the wall-clock
 * budget elapses.
 *
 * Pre-fix bug: when the AbortController fired, `proc.exited` resolved
 * to a SIGTERM exit code (~143) rather than rejecting. The catch
 * branch never ran, and the function returned 143 — bubbled up by the
 * caller as a fuzz crash even though the budget had simply elapsed.
 *
 * Post-fix: a `timedOut` flag is set inside the timer callback. After
 * `proc.exited` resolves we check the flag (plus `signal.aborted`) and
 * return "timeout" regardless of the OS-reported exit code.
 *
 * The test injects a slow `sleep` stub via the `command` test seam so
 * we can exercise timeout detection in ~50ms instead of waiting for a
 * real `zig build fuzz`.
 */
import { expect, test } from "bun:test";
import { runFuzz } from "../../scripts/lib/zig.ts";

test("runFuzz returns 'timeout' when the budget elapses", async () => {
	// `sleep 5` will run far longer than the 50ms budget, so the
	// AbortController must fire and the function must report "timeout"
	// rather than the OS-reported SIGTERM exit code.
	const verdict = await runFuzz({
		limit: "1m",
		timeoutMs: 50,
		command: ["sleep", "5"],
	});
	expect(verdict).toBe("timeout");
});

test("runFuzz returns 'pass' when the command exits 0 in time", async () => {
	const verdict = await runFuzz({
		limit: "1m",
		timeoutMs: 5000,
		command: ["true"],
	});
	expect(verdict).toBe("pass");
});

test("runFuzz returns the exit code on real failure", async () => {
	const verdict = await runFuzz({
		limit: "1m",
		timeoutMs: 5000,
		command: ["false"],
	});
	// `false` exits 1 on every Unix; the contract says we propagate
	// non-zero exits as a numeric verdict so the caller can decide.
	expect(typeof verdict).toBe("number");
	expect(verdict).not.toBe(0);
});
