#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { platformFacts } from "./lib/platform.ts";
import { repoRoot, spawnSync } from "./lib/runtime.ts";

const COVERAGE_SUBPROCESS_TIMEOUT_MS = 300_000;

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
	files?: CoverageFileSummary[];
};

export type CoverageFileSummary = {
	file: string;
	coveredLines: number;
	totalLines: number;
	coveredLineNumbers?: number[];
	totalLineNumbers?: number[];
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
	const realRoot = realpathSync(root);
	let ancestor = dirname(resolved);
	while (!existsSync(ancestor)) {
		const parent = dirname(ancestor);
		if (parent === ancestor) break;
		ancestor = parent;
	}
	const realAncestor = realpathSync(ancestor);
	const realRel = relative(realRoot, realAncestor);
	if (realRel.startsWith("..") || isAbsolute(realRel)) {
		throw new Error(
			`${flag} resolves through a symlink outside the repository`,
		);
	}
	return resolved;
}

function repoRel(root: string, path: string): string {
	return relative(root, path).replaceAll("\\", "/");
}

function assertNoSymlinkAncestors(
	root: string,
	path: string,
	flag: string,
	opts: { includeSelf?: boolean } = {},
): void {
	const rel = repoRel(root, path);
	const parts = rel.split("/").filter((part) => part.length > 0);
	const limit = opts.includeSelf ? parts.length : Math.max(0, parts.length - 1);
	let current = root;
	for (const part of parts.slice(0, limit)) {
		current = resolve(current, part);
		try {
			if (lstatSync(current).isSymbolicLink()) {
				throw new Error(`${flag} must not use symlink ancestors`);
			}
		} catch (err) {
			if (
				err &&
				typeof err === "object" &&
				"code" in err &&
				err.code === "ENOENT"
			) {
				return;
			}
			throw err;
		}
	}
}

function assertRealPathInsideRepo(
	root: string,
	path: string,
	flag: string,
): void {
	const realRoot = realpathSync(root);
	const realPath = realpathSync(path);
	const realRel = relative(realRoot, realPath);
	if (realRel === "" || realRel.startsWith("..") || isAbsolute(realRel)) {
		throw new Error(
			`${flag} resolves through a symlink outside the repository`,
		);
	}
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
	assertNoSymlinkAncestors(root, summaryPath, "--summary-output");
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
	assertNoSymlinkAncestors(root, outputDir, "--output", { includeSelf: true });
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
	const readable = stem.length > 0 ? stem : "target";
	const digest = createHash("sha256").update(target).digest("hex").slice(0, 8);
	return `${readable}_${digest}`;
}

export function resolveCoverageTarget(
	root: string,
	target: string,
): { source: string; targetRel: string } {
	if (isAbsolute(target)) {
		throw new Error("--target must be a repo-local .zig file");
	}
	const source = resolveRepoChild(root, target, "--target");
	const targetRel = repoRel(root, source);
	if (
		targetRel.startsWith("../") ||
		targetRel === ".." ||
		isAbsolute(targetRel)
	) {
		throw new Error("--target must stay inside the repository");
	}
	if (!targetRel.endsWith(".zig")) {
		throw new Error("--target must be a repo-local .zig file");
	}
	return { source, targetRel };
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

function numberFromUnknown(
	value: unknown,
	opts: { percent?: boolean } = {},
): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		if (opts.percent && (value < 0 || value > 100)) return null;
		return value;
	}
	if (typeof value === "string") {
		const normalized = value.replace("%", "").trim();
		if (normalized.length === 0) return null;
		const n = Number(normalized);
		if (Number.isFinite(n)) {
			if (opts.percent && (n < 0 || n > 100)) return null;
			return n;
		}
	}
	return null;
}

function validLineCounts(
	coveredLines: number | null,
	totalLines: number | null,
): { coveredLines: number; totalLines: number } | null {
	if (
		coveredLines === null ||
		totalLines === null ||
		totalLines <= 0 ||
		coveredLines < 0 ||
		coveredLines > totalLines
	) {
		return null;
	}
	return { coveredLines, totalLines };
}

function lineNumberFromUnknown(value: unknown): number | null {
	const n = numberFromUnknown(value);
	if (n === null || !Number.isInteger(n) || n <= 0) return null;
	return n;
}

function lineIsCovered(value: unknown): boolean {
	if (typeof value === "boolean") return value;
	const n = numberFromUnknown(value);
	return n !== null && n > 0;
}

function parseLineDetail(
	entry: Record<string, unknown>,
): { coveredLineNumbers: number[]; totalLineNumbers: number[] } | null {
	const covered = new Set<number>();
	const total = new Set<number>();
	const rawLines = entry.lines;
	if (Array.isArray(rawLines)) {
		for (const rawLine of rawLines) {
			if (typeof rawLine !== "object" || rawLine === null) continue;
			const line = rawLine as Record<string, unknown>;
			const lineNo =
				lineNumberFromUnknown(line.line) ??
				lineNumberFromUnknown(line.line_number) ??
				lineNumberFromUnknown(line.number);
			if (lineNo === null) continue;
			total.add(lineNo);
			if (
				lineIsCovered(line.count) ||
				lineIsCovered(line.hits) ||
				lineIsCovered(line.covered)
			) {
				covered.add(lineNo);
			}
		}
	}
	for (const key of ["line_hits", "lineHits", "hits"]) {
		const rawHits = entry[key];
		if (
			typeof rawHits !== "object" ||
			rawHits === null ||
			Array.isArray(rawHits)
		)
			continue;
		for (const [line, hits] of Object.entries(rawHits)) {
			const lineNo = lineNumberFromUnknown(line);
			if (lineNo === null) continue;
			total.add(lineNo);
			if (lineIsCovered(hits)) covered.add(lineNo);
		}
	}
	if (total.size === 0) return null;
	return {
		coveredLineNumbers: [...covered].sort((a, b) => a - b),
		totalLineNumbers: [...total].sort((a, b) => a - b),
	};
}

function parseCoverageFiles(
	doc: Record<string, unknown>,
): CoverageFileSummary[] {
	const rawFiles = doc.files;
	if (!Array.isArray(rawFiles)) return [];
	const files: CoverageFileSummary[] = [];
	for (const rawFile of rawFiles) {
		if (typeof rawFile !== "object" || rawFile === null) continue;
		const entry = rawFile as Record<string, unknown>;
		const file = entry.file;
		if (typeof file !== "string" || file.length === 0) continue;
		const lineDetail = parseLineDetail(entry);
		if (lineDetail !== null) {
			files.push({
				file,
				coveredLines: lineDetail.coveredLineNumbers.length,
				totalLines: lineDetail.totalLineNumbers.length,
				...lineDetail,
			});
			continue;
		}
		const counts = validLineCounts(
			numberFromUnknown(entry.covered_lines),
			numberFromUnknown(entry.total_lines),
		);
		if (counts === null) continue;
		files.push({ file, ...counts });
	}
	return files;
}

export function parseCoverageSummary(raw: string): CoverageSummary {
	const doc = JSON.parse(raw) as Record<string, unknown>;
	const files = parseCoverageFiles(doc);
	const candidates = [
		doc.line_coverage,
		doc.lineCoverage,
		doc.lines,
		doc.percent_covered,
		doc.percentCovered,
		doc.coverage,
	];
	for (const candidate of candidates) {
		const n = numberFromUnknown(candidate, { percent: true });
		if (n !== null) {
			const counts = validLineCounts(
				numberFromUnknown(doc.covered_lines),
				numberFromUnknown(doc.total_lines),
			);
			return {
				linePercent: n,
				coveredLines: counts?.coveredLines ?? null,
				totalLines: counts?.totalLines ?? null,
				source: "json",
				...(files.length > 0 ? { files } : {}),
			};
		}
	}
	const nested = doc.totals;
	if (typeof nested === "object" && nested !== null) {
		const totals = nested as Record<string, unknown>;
		const n =
			numberFromUnknown(totals.lines, { percent: true }) ??
			numberFromUnknown(totals.line_coverage, { percent: true });
		if (n !== null) {
			const counts = validLineCounts(
				numberFromUnknown(totals.covered_lines),
				numberFromUnknown(totals.total_lines),
			);
			return {
				linePercent: n,
				coveredLines: counts?.coveredLines ?? null,
				totalLines: counts?.totalLines ?? null,
				source: "json.totals",
				...(files.length > 0 ? { files } : {}),
			};
		}
	}
	const counts = validLineCounts(
		numberFromUnknown(doc.covered_lines),
		numberFromUnknown(doc.total_lines),
	);
	if (counts !== null) {
		return {
			linePercent: (counts.coveredLines / counts.totalLines) * 100,
			coveredLines: counts.coveredLines,
			totalLines: counts.totalLines,
			source: "json.counts",
			...(files.length > 0 ? { files } : {}),
		};
	}
	return {
		linePercent: null,
		coveredLines: null,
		totalLines: null,
		source: "json",
		...(files.length > 0 ? { files } : {}),
	};
}

type ParsedCoverageSummary = CoverageSummary & {
	path: string;
	topLevel: boolean;
};

function mergeCoverageSummaries(
	summaries: ParsedCoverageSummary[],
): CoverageSummary | null {
	const fileCounts = new Map<string, CoverageFileSummary>();
	const lineCounts = new Map<
		string,
		{ covered: Set<number>; total: Set<number> }
	>();
	for (const summary of summaries) {
		for (const file of summary.files ?? []) {
			if (
				file.coveredLineNumbers !== undefined &&
				file.totalLineNumbers !== undefined
			) {
				const counts = lineCounts.get(file.file) ?? {
					covered: new Set<number>(),
					total: new Set<number>(),
				};
				for (const line of file.coveredLineNumbers) counts.covered.add(line);
				for (const line of file.totalLineNumbers) counts.total.add(line);
				lineCounts.set(file.file, counts);
				continue;
			}
			const existing = fileCounts.get(file.file);
			if (
				existing === undefined ||
				file.totalLines > existing.totalLines ||
				(file.totalLines === existing.totalLines &&
					file.coveredLines > existing.coveredLines)
			) {
				fileCounts.set(file.file, file);
			}
		}
	}
	for (const [file, counts] of lineCounts) {
		fileCounts.set(file, {
			file,
			coveredLines: counts.covered.size,
			totalLines: counts.total.size,
			coveredLineNumbers: [...counts.covered].sort((a, b) => a - b),
			totalLineNumbers: [...counts.total].sort((a, b) => a - b),
		});
	}
	if (fileCounts.size > 0) {
		let coveredLines = 0;
		let totalLines = 0;
		for (const file of fileCounts.values()) {
			coveredLines += file.coveredLines;
			totalLines += file.totalLines;
		}
		return {
			linePercent: totalLines > 0 ? (coveredLines / totalLines) * 100 : null,
			coveredLines,
			totalLines,
			source: `merged-files:${fileCounts.size}`,
			files: [...fileCounts.values()].sort((a, b) =>
				a.file.localeCompare(b.file),
			),
		};
	}

	const countedNested = summaries.filter(
		(summary) =>
			!summary.topLevel &&
			summary.coveredLines !== null &&
			summary.totalLines !== null &&
			summary.totalLines > 0,
	);
	const counted =
		countedNested.length > 0
			? countedNested
			: summaries.filter(
					(summary) =>
						summary.coveredLines !== null &&
						summary.totalLines !== null &&
						summary.totalLines > 0,
				);
	if (counted.length === 0) return null;
	if (counted.length === 1) {
		const [summary] = counted;
		return {
			linePercent: summary.linePercent,
			coveredLines: summary.coveredLines,
			totalLines: summary.totalLines,
			source: summary.path,
		};
	}
	let coveredLines = 0;
	let totalLines = 0;
	for (const summary of counted) {
		coveredLines += summary.coveredLines ?? 0;
		totalLines += summary.totalLines ?? 0;
	}
	return {
		linePercent: totalLines > 0 ? (coveredLines / totalLines) * 100 : null,
		coveredLines,
		totalLines,
		source: `merged:${counted.length}`,
	};
}

export async function readSummary(outputDir: string): Promise<CoverageSummary> {
	const candidates = new Map<string, boolean>();
	for (const name of ["index.json", "coverage.json", "summary.json"]) {
		candidates.set(resolve(outputDir, name), true);
	}
	for (const pattern of ["**/coverage.json", "**/index.json"]) {
		const glob = new Bun.Glob(pattern);
		for (const path of [
			...glob.scanSync({ cwd: outputDir, absolute: true }),
		].sort()) {
			if (!candidates.has(path)) candidates.set(path, false);
		}
	}
	const summaries: ParsedCoverageSummary[] = [];
	let best: CoverageSummary | null = null;
	for (const [path, topLevel] of candidates) {
		const file = Bun.file(path);
		if (!(await file.exists())) continue;
		const raw = await readFile(path, "utf8");
		let summary: CoverageSummary;
		try {
			summary = parseCoverageSummary(raw);
		} catch {
			continue;
		}
		if (summary.linePercent === null && (summary.files?.length ?? 0) === 0)
			continue;
		const withSource = { ...summary, source: path, path, topLevel };
		summaries.push(withSource);
		const bestLines = best?.totalLines ?? -1;
		const candidateLines = withSource.totalLines ?? 0;
		if (best === null || candidateLines > bestLines) {
			best = {
				linePercent: withSource.linePercent,
				coveredLines: withSource.coveredLines,
				totalLines: withSource.totalLines,
				source: path,
			};
		}
	}
	const merged = mergeCoverageSummaries(summaries);
	if (merged !== null) return merged;
	if (best !== null) return best;
	return {
		linePercent: null,
		coveredLines: null,
		totalLines: null,
		source: "missing",
	};
}

export async function assertSafeSummaryOutput(
	summaryPath: string,
	root?: string,
): Promise<void> {
	if (root !== undefined) {
		assertNoSymlinkAncestors(root, summaryPath, "--summary-output");
	}
	const summaryStat = await lstat(summaryPath).catch((err: unknown) => {
		if (
			err &&
			typeof err === "object" &&
			"code" in err &&
			err.code === "ENOENT"
		) {
			return null;
		}
		throw err;
	});
	if (summaryStat?.isSymbolicLink()) {
		throw new Error("--summary-output must not be a symbolic link");
	}
}

async function emitSummary(
	root: string,
	opts: CoverageOptions,
	event: CoverageEvent,
) {
	const summaryPath = resolveSummaryOutput(root, opts.summaryOutput);
	await mkdir(dirname(summaryPath), { recursive: true });
	await assertSafeSummaryOutput(summaryPath, root);
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
		let resolvedTarget: { source: string; targetRel: string };
		try {
			resolvedTarget = resolveCoverageTarget(root, target);
		} catch (err) {
			console.error(
				`coverage-linux: ${err instanceof Error ? err.message : String(err)}`,
			);
			return 1;
		}
		const { source, targetRel } = resolvedTarget;
		if (!(await Bun.file(source).exists())) {
			console.error(`coverage-linux: target does not exist: ${target}`);
			return 1;
		}
		try {
			assertRealPathInsideRepo(root, source, "--target");
		} catch (err) {
			console.error(
				`coverage-linux: ${err instanceof Error ? err.message : String(err)}`,
			);
			return 1;
		}
		const stem = coverageStem(targetRel);
		const bin = resolve(binDir, `${stem}-test`);
		const compile = spawnSync(zigTestCompileArgs(source, bin), {
			cwd: root,
			timeout: COVERAGE_SUBPROCESS_TIMEOUT_MS,
		});
		process.stdout.write(compile.stdout);
		process.stderr.write(compile.stderr);
		if (compile.code !== 0) return compile.code ?? 1;
		const targetOut = resolve(out, stem);
		const kcov = spawnSync(
			[
				"kcov",
				"--clean",
				`--include-path=${resolve(root, "src")},${resolve(root, "scripts")}`,
				"--exclude-pattern=.zig-cache,zig-out,node_modules,.git,.jj",
				targetOut,
				bin,
			],
			{ cwd: root, timeout: COVERAGE_SUBPROCESS_TIMEOUT_MS },
		);
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
			timeout: COVERAGE_SUBPROCESS_TIMEOUT_MS,
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
