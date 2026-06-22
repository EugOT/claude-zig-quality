#!/usr/bin/env bun
import { appendJsonl, repoRoot, tail } from "./lib/runtime.ts";
// cpuCount is re-used inside lib/zig.ts#runFuzz; verify-pr no longer
// needs a local copy.
/**
 * verify-pr.ts — Tier 3 (~10min).
 *
 * Pre-PR gate. Runs verify-commit first, then:
 *   1. Cross-target build matrix (musl / linux-gnu / macOS / windows / wasi)
 *   2. Safety-mode rotation (Debug, ReleaseSafe, ReleaseFast, ReleaseSmall)
 *   3. Docs build — only if `zig build -l` exposes a `docs` step
 *   4. Bounded fuzz — only if `zig build -l` exposes a `fuzz` step AND
 *      the platform supports fuzz per `zigSupportsFuzz()`. 300s wrapper;
 *      timeout is a clean pass ("fuzz budget elapsed; no crashes").
 *
 * Exit codes:
 *   0 — pass
 *   1 — real failure (fuzz crash, build/test failure)
 */
import {
	hasBuildStep as realHasBuildStep,
	runFuzz as realRunFuzz,
	zig as realZig,
	zigFuzzSkipMessage,
	zigSupportsFuzz as realZigSupportsFuzz,
} from "./lib/zig.ts";

const TIER = "pr" as const;

export const TARGETS: ReadonlyArray<string> = [
	"x86_64-linux-musl",
	"aarch64-linux-gnu",
	"aarch64-macos",
	"x86_64-windows-msvc",
	"wasm32-wasi",
];

export const SAFETY_MODES: ReadonlyArray<string> = [
	"Debug",
	"ReleaseSafe",
	"ReleaseFast",
	"ReleaseSmall",
];

export const FUZZ_TIMEOUT_MS = 300_000;

/**
 * Injection seam for verify-pr's main(). Defaults are the real
 * implementations; tests pass stubs to exercise the cross-target fail-fast,
 * fuzz-skip, and timeout-verdict branches in-process.
 */
export type PrDeps = {
	zig: typeof realZig;
	hasBuildStep: typeof realHasBuildStep;
	zigSupportsFuzz: typeof realZigSupportsFuzz;
	runFuzz: typeof realRunFuzz;
	/** Spawn a child synchronously, inheriting stdio; returns its exit code. */
	spawnInherit: (cmd: string[], cwd: string) => number | null;
};

function defaultSpawnInherit(cmd: string[], cwd: string): number | null {
	return Bun.spawnSync(cmd, {
		cwd,
		stdout: "inherit",
		stderr: "inherit",
		stdin: "ignore",
	}).exitCode;
}

const defaultPrDeps: PrDeps = {
	zig: realZig,
	hasBuildStep: realHasBuildStep,
	zigSupportsFuzz: realZigSupportsFuzz,
	runFuzz: realRunFuzz,
	spawnInherit: defaultSpawnInherit,
};

async function finish(code: number, startedAt: number): Promise<never> {
	const durationMs = Date.now() - startedAt;
	await appendJsonl(".claude/logs/verify.jsonl", {
		event: "verify",
		tier: TIER,
		code,
		durationMs,
	});
	process.exit(code);
}

/**
 * Run the fuzz step under the fixed 300s budget. `runFuzz` is injected so
 * tests can assert the FUZZ_TIMEOUT_MS wiring with a spy.
 */
export async function runFuzzBounded(
	limit: string,
	runFuzz: typeof realRunFuzz = realRunFuzz,
): Promise<"pass" | "timeout" | number> {
	return runFuzz({ limit, timeoutMs: FUZZ_TIMEOUT_MS });
}

export async function main(deps: PrDeps = defaultPrDeps): Promise<void> {
	const startedAt = Date.now();
	const root = repoRoot();

	console.log("== verify-pr -> verify-commit ==");
	const commit = deps.spawnInherit(["bun", "scripts/verify-commit.ts"], root);
	if (commit !== 0) await finish(commit ?? 1, startedAt);

	console.log("== Cross-target build matrix ==");
	for (const target of TARGETS) {
		console.log(`--- ${target}`);
		const build = deps.zig([
			"build",
			`-Dtarget=${target}`,
			"--summary",
			"failures",
		]);
		process.stdout.write(build.stdout);
		process.stderr.write(build.stderr);
		if (build.code !== 0) {
			console.error(
				`verify-pr: cross-target build failed for ${target} (exit ${build.code ?? "?"})`,
			);
			console.error(tail(build.stderr || build.stdout));
			await finish(build.code ?? 1, startedAt);
		}
	}

	console.log("== Safety-mode rotation ==");
	for (const mode of SAFETY_MODES) {
		console.log(`--- ${mode}`);
		const test = deps.zig([
			"build",
			"test",
			`-Doptimize=${mode}`,
			"--summary",
			"failures",
			"--test-timeout",
			"60s",
		]);
		process.stdout.write(test.stdout);
		process.stderr.write(test.stderr);
		if (test.code !== 0) {
			console.error(
				`verify-pr: ${mode} tests failed (exit ${test.code ?? "?"})`,
			);
			console.error(tail(test.stderr || test.stdout));
			await finish(test.code ?? 1, startedAt);
		}
	}

	console.log("== ZLS semantic diagnostics ==");
	const zls = deps.spawnInherit(["bun", "scripts/zls-check.ts"], root);
	if (zls !== 0) {
		console.error("verify-pr: ZLS semantic gate failed");
		await finish(zls ?? 1, startedAt);
	}

	console.log("== Doc coverage (every pub decl documented, §10) ==");
	const docCov = deps.spawnInherit(["bun", "scripts/doc-coverage.ts"], root);
	if (docCov !== 0) {
		console.error("verify-pr: doc-coverage gate failed");
		await finish(docCov ?? 1, startedAt);
	}

	if (deps.hasBuildStep("docs")) {
		console.log("== Generated docs ==");
		const docs = deps.zig(["build", "docs", "--summary", "failures"]);
		process.stdout.write(docs.stdout);
		process.stderr.write(docs.stderr);
		if (docs.code !== 0) {
			console.error("verify-pr: docs build failed");
			await finish(docs.code ?? 1, startedAt);
		}
	} else {
		console.log(
			"(no docs build step — add one so shipment checks can verify generated API docs)",
		);
	}

	if (deps.hasBuildStep("fuzz")) {
		if (deps.zigSupportsFuzz()) {
			const limit = process.env.PR_FUZZ_LIMIT ?? "100K";
			console.log(`== Bounded fuzz (300s, --fuzz=${limit}) ==`);
			const verdict = await runFuzzBounded(limit, deps.runFuzz);
			if (verdict === "timeout") {
				console.log("(fuzz budget elapsed; no crashes)");
			} else if (verdict === "pass") {
				console.log("(fuzz completed within budget)");
			} else {
				// runFuzzBounded never returns 0 here (handled above as "pass").
				console.error(`verify-pr: fuzz crashed (exit ${verdict})`);
				await finish(verdict, startedAt);
			}
		} else {
			console.log(zigFuzzSkipMessage());
		}
	} else {
		console.log(
			"(no 'fuzz' build step — skipping fuzz gate; add one per zig-fuzz-target skill)",
		);
	}

	console.log("verify-pr: OK");
	await finish(0, startedAt);
}

if (import.meta.main) await main();
