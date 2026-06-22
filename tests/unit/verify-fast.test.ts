/**
 * Unit tests for the printFail helper exported from scripts/lib/runtime.ts.
 *
 * Coverage scope:
 *   - printFail() — label+exit-code header line; stdout-only blob; stderr-only
 *     blob; both-streams blob with newline join; empty streams omitted
 *
 * printFail() does NOT call process.exit(), so it can be tested in-process by
 * spying on console.error.
 *
 * main() in scripts/verify-fast.ts calls process.exit() via finish() and has
 * no DI seam, so it is NOT branch-testable in-process. Those paths are covered
 * by the functional/e2e test file (tests/functional/verify-fast-e2e.test.ts).
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { printFail } from "../../scripts/lib/runtime.ts";
import type { SpawnResult } from "../../scripts/lib/runtime.ts";

// ---------------------------------------------------------------------------
// console.error spy — captures output without polluting test stdout
// ---------------------------------------------------------------------------

let errorLines: string[] = [];
let errorSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
	errorLines = [];
	errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
		errorLines.push(args.map(String).join(" "));
	});
});

afterEach(() => {
	errorSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeResult(
	code: number | null,
	stdout: string,
	stderr: string,
): SpawnResult {
	return { code, stdout, stderr };
}

// ===========================================================================
// printFail()
// ===========================================================================

describe("printFail", () => {
	test("(1) emits '<label> failed (exit <N>)' header on first error line", () => {
		printFail("verify-fast: zig fmt --check", makeResult(1, "", ""));
		expect(errorLines[0]).toBe("verify-fast: zig fmt --check failed (exit 1)");
	});

	test("(2) null exit code renders as '?' in header", () => {
		printFail("verify-fast: zig ast-check foo.zig", makeResult(null, "", ""));
		expect(errorLines[0]).toBe("verify-fast: zig ast-check foo.zig failed (exit ?)");
	});

	test("(3) stdout-only: blob line contains stdout text, no empty stderr line", () => {
		const result = makeResult(2, "bad-file.zig\n", "");
		printFail("gate", result);
		// Header is line 0; blob is line 1
		expect(errorLines.length).toBe(2);
		expect(errorLines[1]).toContain("bad-file.zig");
		// Should not contain an empty line artifact from joining empty stderr
		expect(errorLines[1]).not.toMatch(/^\n/);
	});

	test("(4) stderr-only: blob line contains stderr text, stdout omitted", () => {
		const result = makeResult(1, "", "error: expected ';'\n");
		printFail("gate", result);
		expect(errorLines.length).toBe(2);
		expect(errorLines[1]).toContain("error: expected ';'");
	});

	test("(5) both streams: blob joins stdout + stderr with single newline", () => {
		const result = makeResult(1, "fmt-output\n", "ast-error\n");
		printFail("gate", result);
		expect(errorLines.length).toBe(2);
		// Both stream contents must appear in the blob line
		expect(errorLines[1]).toContain("fmt-output");
		expect(errorLines[1]).toContain("ast-error");
	});

	test("(6) both streams empty: only the header line is emitted", () => {
		// When both stdout and stderr are empty the blob is skipped entirely
		const result = makeResult(1, "", "");
		printFail("gate", result);
		expect(errorLines.length).toBe(1);
		expect(errorLines[0]).toContain("failed (exit 1)");
	});
});
