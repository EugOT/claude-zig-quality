#!/usr/bin/env bun
import { collectZigInputs } from "./lib/files.ts";
import {
	appendJsonl,
	type SpawnResult,
	spawnSync,
	tail,
} from "./lib/runtime.ts";
/**
 * verify-fast.ts — Tier 1 (<2s).
 *
 * Runs on every saved edit. Format + AST check only, plus optional ziglint
 * when the EugOT/ziglint binary is on PATH. Fast enough to be wired into
 * PostToolUse:Edit|Write hooks without interrupting flow.
 *
 * Exit codes:
 *   0 — pass (or no Zig inputs to check)
 *   1 — a gate failed; stderr tail printed for the agent
 *
 * Logs a single JSONL entry to `.claude/logs/verify.jsonl` with the tier,
 * exit code, and duration.
 */
import { zig, zigVersion } from "./lib/zig.ts";

const TIER = "fast" as const;

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

function printFail(label: string, result: SpawnResult): void {
	console.error(`verify-fast: ${label} failed (exit ${result.code ?? "?"})`);
	const blob = [result.stdout, result.stderr]
		.filter((s) => s.length > 0)
		.join("\n");
	if (blob.length > 0) console.error(tail(blob));
}

async function main(): Promise<void> {
	const startedAt = Date.now();
	const version = zigVersion();
	if (version.length === 0) {
		console.error(
			"verify-fast: could not resolve a zig toolchain (set $ZIG or install mise)",
		);
		await finish(1, startedAt);
	}
	console.log(`== verify-fast (zig ${version}) ==`);

	const { fmtInputs, zigFiles } = collectZigInputs();
	if (fmtInputs.length === 0 && zigFiles.length === 0) {
		console.log("verify-fast: no Zig files to check");
		await finish(0, startedAt);
	}

	console.log(`== zig fmt --check (${fmtInputs.length} inputs) ==`);
	const fmtResult = zig(["fmt", "--check", ...fmtInputs]);
	if (fmtResult.code !== 0) {
		printFail("zig fmt --check", fmtResult);
		await finish(fmtResult.code ?? 1, startedAt);
	}

	console.log(`== zig ast-check (${zigFiles.length} files) ==`);
	// `zig ast-check` accepts only ONE positional path per invocation in
	// 0.16 (verified empirically: passing multiple gives `error: extra
	// positional parameter`). The CR finding suggested batching, but the
	// CLI does not support it. Keep per-file looping; spawn cost is small
	// relative to ast-check itself.
	for (const file of zigFiles) {
		const ast = zig(["ast-check", file]);
		if (ast.code !== 0) {
			printFail(`zig ast-check ${file}`, ast);
			await finish(ast.code ?? 1, startedAt);
		}
	}

	// Bun.which performs a real PATH lookup; `command` is a shell builtin
	// and cannot be exec'd via Bun.spawnSync (CodeRabbit finding).
	if (Bun.which("ziglint") !== null) {
		console.log("== ziglint (EugOT/ziglint expected) ==");
		const ziglint = spawnSync(["ziglint", ...fmtInputs]);
		process.stdout.write(ziglint.stdout);
		if (ziglint.code !== 0) {
			printFail("ziglint", ziglint);
			await finish(ziglint.code ?? 1, startedAt);
		}
	} else {
		console.log("(ziglint not found; install EugOT/ziglint for the lint gate)");
	}

	console.log("verify-fast: OK");
	await finish(0, startedAt);
}

await main();
