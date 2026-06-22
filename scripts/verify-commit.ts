#!/usr/bin/env bun
/**
 * verify-commit.ts — Tier 2 (~30s).
 *
 * Runs before every commit. Fast gate first, then the full Debug test
 * suite with a 30s per-test cap, and — when `src/lib.zig` exists — the
 * public-API surface check (tolerating the first-run "no baseline" path
 * as a pass).
 *
 * Exit codes:
 *   0 — pass
 *   1 — real failure
 */
import { resolve } from "node:path";
import { appendJsonl, repoRoot, tail } from "./lib/runtime.ts";
import { hasBuildStep as realHasBuildStep, zig as realZig } from "./lib/zig.ts";

const TIER = "commit" as const;

/**
 * Injection seam for verify-commit's main(). Defaults are the real
 * implementations; tests pass stubs to exercise the lint-skip,
 * api-check-skip, and exit-code-propagation branches in-process without
 * spawning a real toolchain.
 */
export type CommitDeps = {
	zig: typeof realZig;
	hasBuildStep: typeof realHasBuildStep;
	/** Spawn a child synchronously, inheriting stdio; returns its exit code. */
	spawnInherit: (cmd: string[], cwd: string) => number | null;
	/** True when a repo-relative path exists. */
	fileExists: (relPath: string) => Promise<boolean>;
};

function defaultSpawnInherit(cmd: string[], cwd: string): number | null {
	return Bun.spawnSync(cmd, {
		cwd,
		stdout: "inherit",
		stderr: "inherit",
		stdin: "ignore",
	}).exitCode;
}

function defaultFileExists(relPath: string): Promise<boolean> {
	return Bun.file(resolve(repoRoot(), relPath)).exists();
}

const defaultCommitDeps: CommitDeps = {
	zig: realZig,
	hasBuildStep: realHasBuildStep,
	spawnInherit: defaultSpawnInherit,
	fileExists: defaultFileExists,
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

export async function main(deps: CommitDeps = defaultCommitDeps): Promise<void> {
	const startedAt = Date.now();
	const root = repoRoot();

	console.log("== verify-commit -> verify-fast ==");
	const fast = deps.spawnInherit(["bun", "scripts/verify-fast.ts"], root);
	if (fast !== 0) await finish(fast ?? 1, startedAt);

	console.log("== zig build test (Debug, --test-timeout 30s) ==");
	const test = deps.zig([
		"build",
		"test",
		"--summary",
		"failures",
		"--test-timeout",
		"30s",
	]);
	process.stdout.write(test.stdout);
	process.stderr.write(test.stderr);
	if (test.code !== 0) {
		console.error(
			`verify-commit: zig build test failed (exit ${test.code ?? "?"})`,
		);
		console.error(tail(test.stderr || test.stdout));
		await finish(test.code ?? 1, startedAt);
	}

	// Authoritative lint gate: `zig build lint` runs the pinned EugOT/ziglint
	// fork (PATH-independent, unlike verify-fast's optional PATH probe). Guarded
	// by hasBuildStep so an adopter who opted out of the ziglint dependency —
	// removing the `lint` step — is not broken by this gate.
	if (deps.hasBuildStep("lint")) {
		console.log("== zig build lint (EugOT/ziglint, pinned) ==");
		const lint = deps.zig(["build", "lint", "--summary", "failures"]);
		process.stdout.write(lint.stdout);
		process.stderr.write(lint.stderr);
		if (lint.code !== 0) {
			console.error(
				`verify-commit: zig build lint failed (exit ${lint.code ?? "?"})`,
			);
			console.error(tail(lint.stderr || lint.stdout));
			await finish(lint.code ?? 1, startedAt);
		}
	} else {
		console.log(
			"(no `lint` build step — ziglint dependency not wired; skipping lint gate)",
		);
	}

	if (await deps.fileExists("src/lib.zig")) {
		console.log("== check-public-api ==");
		const api = deps.spawnInherit(["bun", "scripts/check-public-api.ts"], root);
		if (api !== 0) await finish(api ?? 1, startedAt);
	} else {
		console.log("(no src/lib.zig — skipping public API surface check)");
	}

	console.log("verify-commit: OK");
	await finish(0, startedAt);
}

if (import.meta.main) await main();
