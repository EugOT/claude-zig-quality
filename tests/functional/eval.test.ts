/**
 * Functional (subprocess) tests for scripts/eval.ts.
 *
 * main() calls process.exit() via finish(), so the two paths through main()
 * that reach exit() are exercised by spawning `bun scripts/eval.ts` as a child
 * process. The working directory is set to the real repo root so repoRoot()
 * resolves to the actual tests/evals/ fixture tree.
 *
 * Cases covered:
 *   (11) `bun scripts/eval.ts --check` against the real repo fixtures → exit 0
 *        and stdout contains 'eval --check: OK'
 *   (12) `bun scripts/eval.ts` (no flag) → exit 0, stdout contains 'TODO'
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const BUN_EXE = process.execPath;
const REPO_ROOT = resolve(import.meta.dir, "../..");
const EVAL_SCRIPT = resolve(REPO_ROOT, "scripts", "eval.ts");

// ---------------------------------------------------------------------------
// Subprocess runner
// ---------------------------------------------------------------------------

interface RunResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

async function runEval(args: string[] = []): Promise<RunResult> {
	const proc = Bun.spawn([BUN_EXE, EVAL_SCRIPT, ...args], {
		cwd: REPO_ROOT,
		env: {
			...process.env,
			// Point repoRoot() at the real repo so tests/evals/ resolves correctly.
			CLAUDE_PROJECT_DIR: REPO_ROOT,
		},
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	});

	const [out, err] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const exitCode = await proc.exited;
	return { stdout: out, stderr: err, exitCode };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("eval.ts functional (subprocess)", () => {
	test(
		"(11) --check against real repo fixtures exits 0 with 'eval --check: OK'",
		async () => {
			const { stdout, exitCode } = await runEval(["--check"]);

			expect(exitCode).toBe(0);
			expect(stdout).toContain("eval --check: OK");
		},
		15_000,
	);

	test(
		"(12) no flag exits 0 and stdout contains 'TODO'",
		async () => {
			const { stdout, exitCode } = await runEval([]);

			expect(exitCode).toBe(0);
			expect(stdout).toContain("TODO");
		},
		15_000,
	);
});
