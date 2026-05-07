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
	runFuzz,
	zig,
	zigFuzzSkipMessage,
	zigSupportsFuzz,
} from "./lib/zig.ts";

const TIER = "pr" as const;

const TARGETS: ReadonlyArray<string> = [
	"x86_64-linux-musl",
	"aarch64-linux-gnu",
	"aarch64-macos",
	"x86_64-windows-msvc",
	"wasm32-wasi",
];

const SAFETY_MODES: ReadonlyArray<string> = [
	"Debug",
	"ReleaseSafe",
	"ReleaseFast",
	"ReleaseSmall",
];

const FUZZ_TIMEOUT_MS = 300_000;

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

function hasBuildStep(step: string): boolean {
	const listing = zig(["build", "-l"]);
	const text = `${listing.stdout}\n${listing.stderr}`;
	const escaped = step.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`^[\\t ]*${escaped}(?:\\s|$)`, "m");
	return re.test(text);
}

async function runFuzzBounded(
	limit: string,
): Promise<"pass" | "timeout" | number> {
	return runFuzz({ limit, timeoutMs: FUZZ_TIMEOUT_MS });
}

async function main(): Promise<void> {
	const startedAt = Date.now();
	const root = repoRoot();

	console.log("== verify-pr -> verify-commit ==");
	const commit = Bun.spawnSync(["bun", "scripts/verify-commit.ts"], {
		cwd: root,
		stdout: "inherit",
		stderr: "inherit",
		stdin: "ignore",
	});
	if (commit.exitCode !== 0) await finish(commit.exitCode ?? 1, startedAt);

	console.log("== Cross-target build matrix ==");
	for (const target of TARGETS) {
		console.log(`--- ${target}`);
		const build = zig(["build", `-Dtarget=${target}`, "--summary", "failures"]);
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
		const test = zig([
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

	if (hasBuildStep("docs")) {
		console.log("== Generated docs ==");
		const docs = zig(["build", "docs", "--summary", "failures"]);
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

	if (hasBuildStep("fuzz")) {
		if (zigSupportsFuzz()) {
			const limit = process.env.PR_FUZZ_LIMIT ?? "100K";
			console.log(`== Bounded fuzz (300s, --fuzz=${limit}) ==`);
			const verdict = await runFuzzBounded(limit);
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

await main();
