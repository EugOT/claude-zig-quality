#!/usr/bin/env bun
/**
 * eval.ts — eval harness entry point.
 *
 * `--check` mode validates the fixture skeleton under `tests/evals/`:
 *   1. Every domain under tests/evals/domains/ must have fixtures in
 *      matched pairs: NN-name.zig + NN-name.expect.json
 *   2. Each expect.json must parse as JSON
 *   3. tests/evals/thresholds.json must parse and contain a key for every
 *      domain directory that exists
 *   4. tests/evals/judge-prompt.md must exist
 *   5. tests/evals/trajectories/ must contain at least one .jsonl file
 *
 * Default mode (no `--check`): judge-backed execution is deferred to v1
 * per plan §10.9 — prints a TODO marker and exits 0.
 *
 * Exit codes:
 *   0 — structure valid (check mode) or default TODO mode
 *   1 — structural failure; the specific missing file or parse error is printed
 */
import { readdirSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { appendJsonl, repoRoot } from "./lib/runtime.ts";

const TIER = "eval" as const;

async function finish(code: number, startedAt: number): Promise<never> {
	const durationMs = Date.now() - startedAt;
	await appendJsonl(".claude/logs/verify.jsonl", {
		event: "eval",
		tier: TIER,
		code,
		durationMs,
	});
	process.exit(code);
}

type CheckFailure = { file: string; reason: string };

async function validateExpectJson(
	absPath: string,
): Promise<CheckFailure | null> {
	try {
		const text = await Bun.file(absPath).text();
		JSON.parse(text);
		return null;
	} catch (err) {
		return { file: absPath, reason: `invalid JSON: ${(err as Error).message}` };
	}
}

async function checkStructure(root: string): Promise<CheckFailure[]> {
	const failures: CheckFailure[] = [];
	const domainsRoot = resolve(root, "tests/evals/domains");
	const thresholdsPath = resolve(root, "tests/evals/thresholds.json");
	const judgePromptPath = resolve(root, "tests/evals/judge-prompt.md");
	const trajectoriesDir = resolve(root, "tests/evals/trajectories");

	if (!(await Bun.file(judgePromptPath).exists())) {
		failures.push({
			file: judgePromptPath,
			reason: "missing tests/evals/judge-prompt.md",
		});
	}

	// Enumerate domains via node:fs (Bun.Glob without onlyFiles still
	// returns files only — readdirSync is the reliable directory listing).
	let entries: string[] = [];
	try {
		entries = readdirSync(domainsRoot);
	} catch {
		failures.push({
			file: domainsRoot,
			reason: "missing tests/evals/domains/",
		});
		return failures;
	}
	const liveDomains: string[] = [];
	for (const entry of entries) {
		const abs = resolve(domainsRoot, entry);
		try {
			if (statSync(abs).isDirectory()) liveDomains.push(entry);
		} catch {
			/* ignore */
		}
	}

	for (const domain of liveDomains) {
		const domainDir = resolve(domainsRoot, domain);
		const fileGlob = new Bun.Glob("*.zig");
		const zigFiles: string[] = [];
		for (const f of fileGlob.scanSync({ cwd: domainDir, absolute: true })) {
			zigFiles.push(f);
		}
		for (const zigFile of zigFiles) {
			const base = basename(zigFile, ".zig");
			const expect = resolve(domainDir, `${base}.expect.json`);
			if (!(await Bun.file(expect).exists())) {
				failures.push({
					file: zigFile,
					reason: `missing pair ${base}.expect.json`,
				});
				continue;
			}
			const parseError = await validateExpectJson(expect);
			if (parseError) failures.push(parseError);
		}
		const expectGlob = new Bun.Glob("*.expect.json");
		for (const expect of expectGlob.scanSync({
			cwd: domainDir,
			absolute: true,
		})) {
			const base = basename(expect, ".expect.json");
			const zig = resolve(domainDir, `${base}.zig`);
			if (!(await Bun.file(zig).exists())) {
				failures.push({ file: expect, reason: `missing pair ${base}.zig` });
			}
		}
	}

	if (!(await Bun.file(thresholdsPath).exists())) {
		failures.push({
			file: thresholdsPath,
			reason: "missing tests/evals/thresholds.json",
		});
	} else {
		try {
			const text = await Bun.file(thresholdsPath).text();
			const parsed = JSON.parse(text) as Record<string, unknown>;
			for (const domain of liveDomains) {
				if (!(domain in parsed)) {
					failures.push({
						file: thresholdsPath,
						reason: `thresholds.json missing key for domain '${domain}'`,
					});
				}
			}
		} catch (err) {
			failures.push({
				file: thresholdsPath,
				reason: `invalid JSON: ${(err as Error).message}`,
			});
		}
	}

	let trajCount = 0;
	try {
		const tGlob = new Bun.Glob("*.jsonl");
		for (const _ of tGlob.scanSync({ cwd: trajectoriesDir, absolute: true }))
			trajCount += 1;
	} catch {
		/* handled below */
	}
	if (trajCount === 0) {
		failures.push({
			file: trajectoriesDir,
			reason: "tests/evals/trajectories/ has no *.jsonl files",
		});
	}

	return failures;
}

async function main(): Promise<void> {
	const startedAt = Date.now();
	const root = repoRoot();
	const check = process.argv.includes("--check");

	if (!check) {
		console.log("TODO: judge-backed eval execution pending v1");
		await finish(0, startedAt);
	}

	const failures = await checkStructure(root);
	if (failures.length === 0) {
		console.log("eval --check: OK");
		await finish(0, startedAt);
	}
	for (const f of failures) {
		console.error(`eval --check: ${f.file}: ${f.reason}`);
	}
	await finish(1, startedAt);
}

await main();
