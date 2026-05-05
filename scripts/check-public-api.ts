#!/usr/bin/env bun
/**
 * check-public-api.ts — Public API surface diff.
 *
 * Reads PUBLIC_API_ROOT (default `src/lib.zig`) and compares the current
 * `pub` surface against PUBLIC_API_BASELINE (default `.zig-qm/public-api.txt`).
 *
 * Extraction strategy:
 *   1. If `scripts/zig-api-surface.zig` exists, run it with `zig run` and
 *      treat stdout as the authoritative snapshot.
 *   2. Otherwise fall back to a grep/sed pipeline that lists every top-level
 *      `pub const|fn|var|usingnamespace` declaration.
 *
 * Modes:
 *   (default)    — diff current vs. baseline; exit 1 on drift.
 *   --write      — write the current snapshot to the baseline, then exit 0.
 *
 * Exit codes:
 *   0 — surface matches baseline, or baseline written, or no root exists
 *   1 — drift detected; unified diff printed on stdout
 */
import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { appendJsonl, repoRoot, spawnSync } from "./lib/runtime.ts";
import { zig } from "./lib/zig.ts";

const TIER = "api" as const;

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

async function extractSurface(root: string, rootFile: string): Promise<string> {
	const abs = resolve(root, rootFile);
	const scriptPath = resolve(root, "scripts/zig-api-surface.zig");
	// .exists() never throws; .size on a missing file may. Use the safe form
	// (CodeRabbit finding).
	if (await Bun.file(scriptPath).exists()) {
		const r = zig(["run", "scripts/zig-api-surface.zig", "--", abs]);
		if (r.code === 0) return r.stdout.trimEnd();
	}
	// Fallback: grep-and-sed. Matches lines like:
	//   pub const Foo = ...
	//   pub fn bar() ...
	//   pub var baz ...
	//   pub usingnamespace Qux;
	//   pub extern fn open(...) ...
	//   pub inline fn fast(...) ...
	//   pub export fn exported(...) ...
	// The optional modifier group covers `extern`, `inline`, and `export`.
	const grep = spawnSync([
		"grep",
		"-nE",
		"^[[:space:]]*pub[[:space:]]+((extern|inline|export)[[:space:]]+)?(const|fn|var|usingnamespace)\\b",
		abs,
	]);
	if (grep.code !== 0) return "";
	const sed = Bun.spawnSync(["sed", "-E", "s/[[:space:]]+/ /g"], {
		stdin: new TextEncoder().encode(grep.stdout),
		stdout: "pipe",
		stderr: "pipe",
	});
	return (sed.stdout?.toString() ?? "").trimEnd();
}

async function main(): Promise<void> {
	const startedAt = Date.now();
	const root = repoRoot();
	const rootFile = process.env.PUBLIC_API_ROOT ?? "src/lib.zig";
	const baselinePath =
		process.env.PUBLIC_API_BASELINE ?? ".zig-qm/public-api.txt";
	const write =
		process.argv.includes("--write") || process.argv.includes("write");

	const absRoot = resolve(root, rootFile);
	if (!(await Bun.file(absRoot).exists())) {
		console.log(
			`(no public API root at ${rootFile}; skipping public surface check)`,
		);
		await finish(0, startedAt);
	}

	const current = await extractSurface(root, rootFile);

	const absBaseline = resolve(root, baselinePath);
	if (write) {
		const dir = dirname(absBaseline);
		spawnSync(["mkdir", "-p", dir]);
		await Bun.write(absBaseline, `${current}\n`);
		console.log(`check-public-api: wrote baseline to ${baselinePath}`);
		await finish(0, startedAt);
	}

	const baselineFile = Bun.file(absBaseline);
	if (!(await baselineFile.exists())) {
		console.log("(no public API baseline; current surface follows)");
		console.log(current);
		await finish(0, startedAt);
	}

	const baseline = (await baselineFile.text()).trimEnd();
	if (baseline === current) {
		console.log("check-public-api: OK (surface matches baseline)");
		await finish(0, startedAt);
	}

	// Drift — emit a unified diff via /usr/bin/diff, tolerating its exit=1.
	const tmpA = resolve(root, ".zig-qm/.api-baseline.tmp");
	const tmpB = resolve(root, ".zig-qm/.api-current.tmp");
	try {
		spawnSync(["mkdir", "-p", resolve(root, ".zig-qm")]);
		await Bun.write(tmpA, `${baseline}\n`);
		await Bun.write(tmpB, `${current}\n`);
		const diff = spawnSync(["diff", "-u", tmpA, tmpB]);
		process.stdout.write(diff.stdout);
		console.error("check-public-api: public surface drifted");
	} finally {
		// Best-effort cleanup; never let scratch files leak between runs.
		await rm(tmpA, { force: true });
		await rm(tmpB, { force: true });
	}
	await finish(1, startedAt);
}

await main();
