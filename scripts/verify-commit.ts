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
import { hasBuildStep, zig } from "./lib/zig.ts";

const TIER = "commit" as const;

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

async function main(): Promise<void> {
	const startedAt = Date.now();
	const root = repoRoot();

	console.log("== verify-commit -> verify-fast ==");
	const fast = Bun.spawnSync(["bun", "scripts/verify-fast.ts"], {
		cwd: root,
		stdout: "inherit",
		stderr: "inherit",
		stdin: "ignore",
	});
	if (fast.exitCode !== 0) await finish(fast.exitCode ?? 1, startedAt);

	console.log("== zig build test (Debug, --test-timeout 30s) ==");
	const test = zig([
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
	if (hasBuildStep("lint")) {
		console.log("== zig build lint (EugOT/ziglint, pinned) ==");
		const lint = zig(["build", "lint", "--summary", "failures"]);
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

	const libZig = Bun.file(resolve(root, "src/lib.zig"));
	if (await libZig.exists()) {
		console.log("== check-public-api ==");
		const api = Bun.spawnSync(["bun", "scripts/check-public-api.ts"], {
			cwd: root,
			stdout: "inherit",
			stderr: "inherit",
			stdin: "ignore",
		});
		if (api.exitCode !== 0) await finish(api.exitCode ?? 1, startedAt);
	} else {
		console.log("(no src/lib.zig — skipping public API surface check)");
	}

	console.log("verify-commit: OK");
	await finish(0, startedAt);
}

await main();
