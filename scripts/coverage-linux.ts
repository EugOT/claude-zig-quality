#!/usr/bin/env bun
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { platformFacts } from "./lib/platform.ts";
import { repoRoot, spawnSync } from "./lib/runtime.ts";

export type CoverageOptions = {
	outputDir: string;
	summaryOutput: string;
	failUnderLines: number | null;
	allowNonLinux: boolean;
	skipMissingKcov: boolean;
	mode: "zig-tests" | "command";
	command: string[];
	targets: string[];
};

export type CoverageSummary = {
	linePercent: number | null;
	coveredLines: number | null;
	totalLines: number | null;
	source: string;
};

export type CoverageEvent = {
	event: "coverage-linux";
	status: "ok" | "skipped" | "failed";
	reason?: string;
	lane: string;
	platform: string;
	linePercent?: number | null;
	coveredLines?: number | null;
	totalLines?: number | null;
	source?: string;
	outputDir?: string;
};

function takeValue(argv: string[], index: number, flag: string): string {
	const value = argv[index + 1];
	if (!value || value.startsWith("--"))
		throw new Error(`${flag} requires a value`);
	return value;
}

export function resolveRepoChild(
	root: string,
	value: string,
	flag: string,
): string {
	const resolved = resolve(root, value);
	const rel = relative(root, resolved);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(
			`${flag} must stay inside the repository and cannot be the repo root`,
		);
	}
	return resolved;
}

function repoRel(root: string, path: string): string {
	return relative(root, path).replaceAll("\\", "/");
}

function isGeneratedCoveragePath(root: string, path: string): boolean {
	const rel = repoRel(root, path);
	return (
		rel === "zig-out/coverage" ||
		rel.startsWith("zig-out/coverage/") ||
		rel === "coverage/kcov" ||
		rel.startsWith("coverage/kcov/")
	);
}

export function resolveSummaryOutput(root: string, value: string): string {
	const summaryPath = resolveRepoChild(root, value, "--summary-output");
	const rel = repoRel(root, summaryPath);
	if (
		rel !== "coverage/summary.json" &&
		!rel.startsWith("coverage/") &&
		!rel.startsWith("zig-out/coverage/")
	) {
		throw new Error(
			"--summary-output must stay under coverage/ or zig-out/coverage/",
		);
	}
	return summaryPath;
}

export function assertSafeCoverageOutput(
	root: string,
	outputDir: string,
): void {
	const rel = repoRel(root, outputDir);
	if (!isGeneratedCoveragePath(root, outputDir)) {
		throw new Error(
			"--output must be under zig-out/coverage/ or coverage/kcov/",
		);
	}
	const isRepo = spawnSync(["git", "rev-parse", "--is-inside-work-tree"], {
		cwd: root,
		timeout: 5_000,
	});
	if (isRepo.timedOut) {
		throw new Error(`--output safety check timed out for ${rel}`);
	}
	if (isRepo.code !== 0) return;
	const tracked = spawnSync(["git", "ls-files", "--", rel], {
		cwd: root,
		timeout: 5_000,
	});
	if (tracked.timedOut || tracked.code !== 0) {
		throw new Error(
			`--output safety check failed for ${rel}; refusing to delete`,
		);
	}
	if (tracked.stdout.trim().length > 0) {
		throw new Error(`--output contains tracked files: ${rel}`);
	}
}

export function coverageStem(target: string): string {
	const withoutExt = target.replace(/\.zig$/, "");
	const stem = withoutExt.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+/, "");
	return stem.length > 0 ? stem : "target";
}

export function parseCoverageArgs(argv: string[]): CoverageOptions {
	let outputDir = "zig-out/coverage/kcov";
	let summaryOutput = "coverage/summary.json";
	let failUnderLines: number | null = null;
	let allowNonLinux = false;
	let skipMissingKcov = false;
	let targets: string[] = ["src/hello.zig", "src/lib.zig", "src/root.zig"];
	let targetsExplicit = false;
	let command: string[] = [
		"mise",
		"x",
		"zig@0.16.0",
		"--",
		"zig",
		"build",
		"test",
		"--summary",
		"failures",
	];
	let mode: "zig-tests" | "command" = "zig-tests";

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") {
			command = argv.slice(i + 1);
			mode = "command";
			break;
		}
		switch (arg) {
			case "--output":
				outputDir = takeValue(argv, i, arg);
				i++;
				break;
			case "--summary-output":
				summaryOutput = takeValue(argv, i, arg);
				i++;
				break;
			case "--fail-under-lines": {
				const raw = Number(takeValue(argv, i, arg));
				if (!Number.isFinite(raw) || raw < 0 || raw > 100) {
					throw new Error("--fail-under-lines must be a number in [0, 100]");
				}
				failUnderLines = raw;
				i++;
				break;
			}
			case "--allow-non-linux":
				allowNonLinux = true;
				break;
			case "--skip-missing-kcov":
				skipMissingKcov = true;
				break;
			case "--target":
				if (!targetsExplicit) {
					targets = [];
					targetsExplicit = true;
				}
				targets.push(takeValue(argv, i, arg));
				i++;
				break;
			case "--targets": {
				const raw = takeValue(argv, i, arg);
				targets = raw
					.split(",")
					.map((s) => s.trim())
					.filter((s) => s.length > 0);
				targetsExplicit = true;
				i++;
				break;
			}
			case "--command-mode":
				mode = "command";
				break;
			default:
				throw new Error(`unknown argument: ${arg}`);
		}
	}
	if (command.length === 0)
		throw new Error("coverage command after -- is empty");
	if (mode === "zig-tests" && targets.length === 0) {
		throw new Error("coverage zig-tests mode requires at least one target");
	}
	return {
		outputDir,
		summaryOutput,
		failUnderLines,
		allowNonLinux,
		skipMissingKcov,
		mode,
		command,
		targets,
	};
}

export function buildKcovArgs(opts: CoverageOptions): string[] {
	return [
		"kcov",
		"--include-path=src,scripts",
		"--exclude-pattern=.zig-cache,zig-out,node_modules,.git,.jj",
		opts.outputDir,
		...opts.command,
	];
}

export function zigTestCompileArgs(source: string, output: string): string[] {
	const zig = process.env.ZIG;
	if (zig && zig.length > 0) {
		return [zig, "test", source, "--test-no-exec", `-femit-bin=${output}`];
	}
	if (Bun.which("mise") !== null) {
		return [
			"mise",
			"x",
			"zig@0.16.0",
			"--",
			"zig",
			"test",
			source,
			"--test-no-exec",
			`-femit-bin=${output}`,
		];
	}
	return ["zig", "test", source, "--test-no-exec", `-femit-bin=${output}`];
}

function numberFromUnknown(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const n = Number(value.replace("%", ""));
		if (Number.isFinite(n)) return n;
	}
	return null;
}

export function parseCoverageSummary(raw: string): CoverageSummary {
	const doc = JSON.parse(raw) as Record<string, unknown>;
	const candidates = [
		doc.line_coverage,
		doc.lineCoverage,
		doc.lines,
		doc.percent_covered,
		doc.percentCovered,
		doc.coverage,
	];
	for (const candidate of candidates) {
		const n = numberFromUnknown(candidate);
		if (n !== null) {
			return {
				linePercent: n,
				coveredLines: numberFromUnknown(doc.covered_lines),
				totalLines: numberFromUnknown(doc.total_lines),
				source: "json",
			};
		}
	}
	const nested = doc.totals;
	if (typeof nested === "object" && nested !== null) {
		const totals = nested as Record<string, unknown>;
		const n =
			numberFromUnknown(totals.lines) ??
			numberFromUnknown(totals.line_coverage);
		if (n !== null) {
			return {
				linePercent: n,
				coveredLines: numberFromUnknown(totals.covered_lines),
				totalLines: numberFromUnknown(totals.total_lines),
				source: "json.totals",
			};
		}
	}
	return {
		linePercent: null,
		coveredLines: numberFromUnknown(doc.covered_lines),
		totalLines: numberFromUnknown(doc.total_lines),
		source: "json",
	};
}

async function readSummary(outputDir: string): Promise<CoverageSummary> {
	const candidates = ["index.json", "coverage.json", "summary.json"].map(
		(name) => resolve(outputDir, name),
	);
	const coverageGlob = new Bun.Glob("**/coverage.json");
	for (const path of [
		...coverageGlob.scanSync({ cwd: outputDir, absolute: true }),
	].sort()) {
		candidates.push(path);
	}
	let best: CoverageSummary | null = null;
	for (const path of candidates) {
		const file = Bun.file(path);
		if (!(await file.exists())) continue;
		const raw = await readFile(path, "utf8");
		const summary = parseCoverageSummary(raw);
		if (summary.linePercent === null) continue;
		const withSource = { ...summary, source: path };
		const bestLines = best?.totalLines ?? -1;
		const candidateLines = withSource.totalLines ?? 0;
		if (best === null || candidateLines > bestLines) best = withSource;
	}
	if (best !== null) return best;
	return {
		linePercent: null,
		coveredLines: null,
		totalLines: null,
		source: "missing",
	};
}

async function emitSummary(
	root: string,
	opts: CoverageOptions,
	event: CoverageEvent,
) {
	const summaryPath = resolveSummaryOutput(root, opts.summaryOutput);
	await mkdir(dirname(summaryPath), { recursive: true });
	await writeFile(summaryPath, `${JSON.stringify(event, null, 2)}\n`);
	console.log(JSON.stringify(event));
}

async function runZigTestCoverage(
	root: string,
	opts: CoverageOptions,
	out: string,
): Promise<number | null> {
	const binDir = resolve(out, "bin");
	await mkdir(binDir, { recursive: true });
	for (const target of opts.targets) {
		const source = resolve(root, target);
		if (!(await Bun.file(source).exists())) {
			console.error(`coverage-linux: target does not exist: ${target}`);
			return 1;
		}
		const stem = coverageStem(target);
		const bin = resolve(binDir, `${stem}-test`);
		const compile = spawnSync(zigTestCompileArgs(source, bin), { cwd: root });
		process.stdout.write(compile.stdout);
		process.stderr.write(compile.stderr);
		if (compile.code !== 0) return compile.code ?? 1;
		const targetOut = resolve(out, stem);
		const kcov = spawnSync([
			"kcov",
			"--clean",
			`--include-path=${resolve(root, "src")},${resolve(root, "scripts")}`,
			"--exclude-pattern=.zig-cache,zig-out,node_modules,.git,.jj",
			targetOut,
			bin,
		]);
		process.stdout.write(kcov.stdout);
		process.stderr.write(kcov.stderr);
		if (kcov.code !== 0) return kcov.code ?? 1;
	}
	return null;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
	const opts = parseCoverageArgs(argv);
	const facts = platformFacts();
	const root = repoRoot();
	if (facts.platform !== "linux" && !opts.allowNonLinux) {
		await emitSummary(root, opts, {
			event: "coverage-linux",
			status: "skipped",
			reason: "non-linux",
			lane: facts.lane,
			platform: facts.platform,
		});
		return;
	}

	if (Bun.which("kcov") === null) {
		const payload = {
			event: "coverage-linux",
			status: opts.skipMissingKcov ? "skipped" : "failed",
			reason: "kcov-missing",
			lane: facts.lane,
			platform: facts.platform,
		} satisfies CoverageEvent;
		await emitSummary(root, opts, payload);
		process.exit(opts.skipMissingKcov ? 0 : 127);
	}

	const out = resolveRepoChild(root, opts.outputDir, "--output");
	assertSafeCoverageOutput(root, out);
	await rm(out, { recursive: true, force: true });
	await mkdir(out, { recursive: true });
	if (opts.mode === "zig-tests") {
		const code = await runZigTestCoverage(root, opts, out);
		if (code !== null) {
			await emitSummary(root, opts, {
				event: "coverage-linux",
				status: "failed",
				reason: "coverage-command-failed",
				lane: facts.lane,
				platform: facts.platform,
				outputDir: out,
			});
			process.exit(code);
		}
	} else {
		const run = spawnSync(buildKcovArgs({ ...opts, outputDir: out }), {
			cwd: root,
		});
		process.stdout.write(run.stdout);
		process.stderr.write(run.stderr);
		if (run.code !== 0) {
			await emitSummary(root, opts, {
				event: "coverage-linux",
				status: "failed",
				reason: "coverage-command-failed",
				lane: facts.lane,
				platform: facts.platform,
				outputDir: out,
			});
			process.exit(run.code ?? 1);
		}
	}

	const summary = await readSummary(out);
	let status: CoverageEvent["status"] =
		summary.linePercent === null ? "failed" : "ok";
	let reason =
		summary.linePercent === null ? "coverage-summary-missing" : undefined;
	if (
		opts.failUnderLines !== null &&
		summary.linePercent !== null &&
		summary.linePercent < opts.failUnderLines
	) {
		status = "failed";
		reason = "coverage-threshold";
	}
	const event: CoverageEvent = {
		event: "coverage-linux",
		status,
		reason,
		lane: facts.lane,
		platform: facts.platform,
		linePercent: summary.linePercent,
		coveredLines: summary.coveredLines,
		totalLines: summary.totalLines,
		source: summary.source,
		outputDir: out,
	};
	await emitSummary(root, opts, event);
	if (opts.failUnderLines !== null) {
		if (summary.linePercent === null) {
			console.error(
				`coverage-linux: could not read line coverage summary under ${out}`,
			);
			process.exit(1);
		}
		if (summary.linePercent < opts.failUnderLines) {
			console.error(
				`coverage-linux: line coverage ${summary.linePercent}% is below ${opts.failUnderLines}%`,
			);
			process.exit(1);
		}
	}
	if (summary.linePercent === null) process.exit(1);
}

if (import.meta.main) await main();
