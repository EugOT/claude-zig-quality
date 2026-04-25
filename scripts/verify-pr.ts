#!/usr/bin/env bun
import { appendJsonl, repoRoot, tail } from "./lib/runtime.ts";
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
import { zig, zigFuzzSkipMessage, zigSupportsFuzz } from "./lib/zig.ts";

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

function cpuCount(): number {
	// Prefer node:os in server-side Bun; navigator.hardwareConcurrency is
	// a browser shim that can be undefined or wrong in CI containers.
	try {
		const { cpus } = require("node:os") as typeof import("node:os");
		const n = cpus().length;
		return n > 0 ? n : 4;
	} catch {
		return 4;
	}
}

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
	const re = new RegExp(`^[\\s]+${step}[\\s]`, "m");
	return re.test(text);
}

async function runFuzzBounded(
	limit: string,
): Promise<"pass" | "timeout" | number> {
	const root = repoRoot();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FUZZ_TIMEOUT_MS);
	const cmd = [
		"bun",
		"-e",
		"import { zig } from './scripts/lib/zig.ts';" +
			"const args = JSON.parse(process.argv[1] ?? '[]');" +
			"const r = zig(args);" +
			"process.stdout.write(r.stdout);" +
			"process.stderr.write(r.stderr);" +
			"process.exit(r.code ?? 1);",
		JSON.stringify([
			"build",
			"fuzz",
			"--summary",
			"failures",
			`--fuzz=${limit}`,
			`-j${cpuCount()}`,
		]),
	];
	const proc = Bun.spawn(cmd, {
		cwd: root,
		stdout: "inherit",
		stderr: "inherit",
		stdin: "ignore",
		signal: controller.signal,
	});
	try {
		const code = await proc.exited;
		clearTimeout(timer);
		if (code === 0) return "pass";
		return code;
	} catch {
		clearTimeout(timer);
		return "timeout";
	}
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
