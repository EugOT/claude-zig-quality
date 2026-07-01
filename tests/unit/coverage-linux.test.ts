import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertSafeCoverageOutput,
	assertSafeSummaryOutput,
	buildKcovArgs,
	coverageStem,
	parseCoverageArgs,
	parseCoverageSummary,
	readSummary,
	resolveCoverageTarget,
	resolveRepoChild,
	resolveSummaryOutput,
	zigTestCompileArgs,
} from "../../scripts/coverage-linux.ts";
import { spawnSync } from "../../scripts/lib/runtime.ts";

describe("coverage-linux argument parsing", () => {
	test("uses safe defaults", () => {
		const opts = parseCoverageArgs([]);
		expect(opts.outputDir).toBe("zig-out/coverage/kcov");
		expect(opts.summaryOutput).toBe("coverage/summary.json");
		expect(opts.failUnderLines).toBeNull();
		expect(opts.allowNonLinux).toBe(false);
		expect(opts.mode).toBe("zig-tests");
		expect(opts.targets).toContain("src/hello.zig");
		expect(opts.targets).not.toContain("scripts/zig-doc-coverage.zig");
		expect(opts.command).toEqual([
			"mise",
			"x",
			"zig@0.16.0",
			"--",
			"zig",
			"build",
			"test",
			"--summary",
			"failures",
		]);
	});

	test("parses threshold and command after --", () => {
		const opts = parseCoverageArgs([
			"--output",
			"out/cov",
			"--fail-under-lines",
			"95",
			"--summary-output",
			"out/summary.json",
			"--allow-non-linux",
			"--skip-missing-kcov",
			"--",
			"bun",
			"scripts/verify-pr.ts",
		]);
		expect(opts.outputDir).toBe("out/cov");
		expect(opts.summaryOutput).toBe("out/summary.json");
		expect(opts.failUnderLines).toBe(95);
		expect(opts.allowNonLinux).toBe(true);
		expect(opts.skipMissingKcov).toBe(true);
		expect(opts.mode).toBe("command");
		expect(opts.command).toEqual(["bun", "scripts/verify-pr.ts"]);
	});

	test("rejects invalid coverage threshold", () => {
		expect(() => parseCoverageArgs(["--fail-under-lines", "101"])).toThrow(
			/in \[0, 100\]/,
		);
	});

	test("builds kcov argv", () => {
		const opts = parseCoverageArgs([
			"--output",
			"out",
			"--",
			"zig",
			"build",
			"test",
		]);
		expect(buildKcovArgs(opts)).toEqual([
			"kcov",
			"--include-path=src,scripts",
			"--exclude-pattern=.zig-cache,zig-out,node_modules,.git,.jj",
			"out",
			"zig",
			"build",
			"test",
		]);
	});

	test("parses explicit zig test targets", () => {
		const opts = parseCoverageArgs(["--targets", "src/a.zig, scripts/b.zig"]);
		expect(opts.mode).toBe("zig-tests");
		expect(opts.targets).toEqual(["src/a.zig", "scripts/b.zig"]);
	});

	test("single --target clears defaults and repeated --target accumulates", () => {
		const opts = parseCoverageArgs([
			"--target",
			"src/a.zig",
			"--target",
			"src/b.zig",
		]);
		expect(opts.targets).toEqual(["src/a.zig", "src/b.zig"]);
	});

	test("builds zig test compile argv", () => {
		const previous = process.env.ZIG;
		process.env.ZIG = "/tmp/zig";
		try {
			expect(zigTestCompileArgs("src/a.zig", "out/a-test")).toEqual([
				"/tmp/zig",
				"test",
				"src/a.zig",
				"--test-no-exec",
				"-femit-bin=out/a-test",
			]);
		} finally {
			if (previous === undefined) delete process.env.ZIG;
			else process.env.ZIG = previous;
		}
	});

	test("honors explicit ZIG override for pinned containers", () => {
		const previous = process.env.ZIG;
		process.env.ZIG = "/usr/local/bin/zig";
		try {
			expect(zigTestCompileArgs("src/a.zig", "out/a-test")).toEqual([
				"/usr/local/bin/zig",
				"test",
				"src/a.zig",
				"--test-no-exec",
				"-femit-bin=out/a-test",
			]);
		} finally {
			if (previous === undefined) delete process.env.ZIG;
			else process.env.ZIG = previous;
		}
	});

	test("rejects dangerous output directories", async () => {
		const root = await mkdtemp(join(tmpdir(), "coverage-root-"));
		expect(() => resolveRepoChild(root, ".", "--output")).toThrow(
			"cannot be the repo root",
		);
		expect(() => resolveRepoChild(root, "..", "--output")).toThrow(
			"must stay inside the repository",
		);
		expect(resolveRepoChild(root, "zig-out/coverage", "--output")).toBe(
			join(root, "zig-out/coverage"),
		);
	});

	test("rejects symlink escapes through existing ancestors", async () => {
		const root = await mkdtemp(join(tmpdir(), "coverage-root-"));
		const outside = await mkdtemp(join(tmpdir(), "coverage-outside-"));
		await symlink(outside, join(root, "link"));
		expect(() =>
			resolveRepoChild(root, "link/coverage/kcov", "--output"),
		).toThrow("symlink outside the repository");
	});

	test("rejects in-repo symlink ancestors for generated paths", async () => {
		const root = await mkdtemp(join(tmpdir(), "coverage-root-"));
		await mkdir(join(root, "real-coverage"), { recursive: true });
		await symlink(join(root, "real-coverage"), join(root, "coverage"));
		expect(() => resolveSummaryOutput(root, "coverage/summary.json")).toThrow(
			"symlink ancestors",
		);

		const root2 = await mkdtemp(join(tmpdir(), "coverage-root-"));
		await mkdir(join(root2, "real-zig-out"), { recursive: true });
		await symlink(join(root2, "real-zig-out"), join(root2, "zig-out"));
		expect(() =>
			assertSafeCoverageOutput(root2, join(root2, "zig-out/coverage/kcov")),
		).toThrow("symlink ancestors");
	});

	test("rejects option-looking flag values", () => {
		expect(() =>
			parseCoverageArgs(["--summary-output", "--allow-non-linux"]),
		).toThrow("--summary-output requires a value");
	});

	test("summary output cannot escape generated summary locations", async () => {
		const root = await mkdtemp(join(tmpdir(), "coverage-root-"));
		expect(() => resolveSummaryOutput(root, "../summary.json")).toThrow(
			"must stay inside the repository",
		);
		expect(() => resolveSummaryOutput(root, "README.md")).toThrow(
			"must stay under coverage/",
		);
		expect(resolveSummaryOutput(root, "coverage/summary.json")).toBe(
			join(root, "coverage/summary.json"),
		);
	});

	test("summary output rejects symlink destination files", async () => {
		const root = await mkdtemp(join(tmpdir(), "coverage-root-"));
		const outside = join(root, "outside-summary.json");
		const link = join(root, "coverage/summary.json");
		await mkdir(join(root, "coverage"), { recursive: true });
		await writeFile(outside, "{}");
		await symlink(outside, link);
		await expect(assertSafeSummaryOutput(link)).rejects.toThrow(
			"must not be a symbolic link",
		);
	});

	test("summary output rejects symlink ancestors", async () => {
		const root = await mkdtemp(join(tmpdir(), "coverage-root-"));
		await mkdir(join(root, "real-coverage"), { recursive: true });
		await symlink(join(root, "real-coverage"), join(root, "coverage"));
		await expect(
			assertSafeSummaryOutput(join(root, "coverage/summary.json"), root),
		).rejects.toThrow("symlink ancestors");
	});

	test("coverage output cleanup is limited to generated coverage directories", async () => {
		const root = await mkdtemp(join(tmpdir(), "coverage-root-"));
		expect(() => assertSafeCoverageOutput(root, join(root, "src"))).toThrow(
			"must be under zig-out/coverage/",
		);
		expect(() =>
			assertSafeCoverageOutput(root, join(root, "zig-out/coverage/kcov")),
		).not.toThrow();
	});

	test("coverage output refuses tracked files even under generated directories", async () => {
		const root = await mkdtemp(join(tmpdir(), "coverage-git-"));
		spawnSync(["git", "init"], { cwd: root });
		await mkdir(join(root, "zig-out/coverage/kcov"), { recursive: true });
		await writeFile(join(root, "zig-out/coverage/kcov/tracked.txt"), "x");
		spawnSync(["git", "add", "zig-out/coverage/kcov/tracked.txt"], {
			cwd: root,
		});
		expect(() =>
			assertSafeCoverageOutput(root, join(root, "zig-out/coverage/kcov")),
		).toThrow("contains tracked files");
	});

	test("coverage stems include directory context", () => {
		const a = coverageStem("src/a/mod.zig");
		const b = coverageStem("src/b/mod.zig");
		expect(a).toMatch(/^src_a_mod_[0-9a-f]{8}$/);
		expect(b).toMatch(/^src_b_mod_[0-9a-f]{8}$/);
		expect(a).not.toBe(b);
	});

	test("coverage targets must be repo-local Zig files", async () => {
		const root = await mkdtemp(join(tmpdir(), "coverage-root-"));
		await mkdir(join(root, "src"), { recursive: true });
		await writeFile(join(root, "src/main.zig"), "test {}\n");
		expect(resolveCoverageTarget(root, "src/main.zig")).toEqual({
			source: join(root, "src/main.zig"),
			targetRel: "src/main.zig",
		});
		expect(() => resolveCoverageTarget(root, "../outside.zig")).toThrow(
			"must stay inside the repository",
		);
		expect(() =>
			resolveCoverageTarget(root, join(tmpdir(), "outside.zig")),
		).toThrow("repo-local .zig file");
		expect(() => resolveCoverageTarget(root, "src/main.txt")).toThrow(
			"repo-local .zig file",
		);
	});
});

describe("coverage summary parsing", () => {
	test("reads common flat line coverage keys", () => {
		expect(parseCoverageSummary('{"line_coverage": 95.5}')).toEqual({
			linePercent: 95.5,
			coveredLines: null,
			totalLines: null,
			source: "json",
		});
		expect(parseCoverageSummary('{"percentCovered": "96%"}').linePercent).toBe(
			96,
		);
	});

	test("reads nested totals", () => {
		expect(parseCoverageSummary('{"totals":{"lines": 97}}')).toEqual({
			linePercent: 97,
			coveredLines: null,
			totalLines: null,
			source: "json.totals",
		});
	});

	test("reads kcov covered and total line counts", () => {
		expect(
			parseCoverageSummary(
				'{"percent_covered":"96.05","covered_lines":73,"total_lines":76}',
			),
		).toEqual({
			linePercent: 96.05,
			coveredLines: 73,
			totalLines: 76,
			source: "json",
		});
	});

	test("derives line coverage from count-only summaries", () => {
		expect(
			parseCoverageSummary('{"covered_lines":73,"total_lines":76}'),
		).toEqual({
			linePercent: (73 / 76) * 100,
			coveredLines: 73,
			totalLines: 76,
			source: "json.counts",
		});
	});

	test("returns null when no known coverage key exists", () => {
		expect(parseCoverageSummary('{"foo": 1}')).toEqual({
			linePercent: null,
			coveredLines: null,
			totalLines: null,
			source: "json",
		});
	});

	test("rejects impossible coverage percentages", () => {
		expect(
			parseCoverageSummary('{"line_coverage": 101}').linePercent,
		).toBeNull();
		expect(
			parseCoverageSummary('{"totals":{"lines": -1}}').linePercent,
		).toBeNull();
		expect(
			parseCoverageSummary('{"line_coverage": ""}').linePercent,
		).toBeNull();
		expect(
			parseCoverageSummary('{"line_coverage": " "}').linePercent,
		).toBeNull();
		expect(
			parseCoverageSummary('{"line_coverage": "%"}').linePercent,
		).toBeNull();
	});

	test("omits invalid line counts from percentage summaries", () => {
		expect(
			parseCoverageSummary(
				'{"percent_covered":"90","covered_lines":11,"total_lines":10}',
			),
		).toEqual({
			linePercent: 90,
			coveredLines: null,
			totalLines: null,
			source: "json",
		});
		expect(
			parseCoverageSummary(
				'{"totals":{"lines":90,"covered_lines":-1,"total_lines":10}}',
			),
		).toEqual({
			linePercent: 90,
			coveredLines: null,
			totalLines: null,
			source: "json.totals",
		});
	});

	test("reads nested kcov index summaries", async () => {
		const root = await mkdtemp(join(tmpdir(), "coverage-summary-"));
		await mkdir(join(root, "nested"), { recursive: true });
		await writeFile(join(root, "nested/index.json"), '{"line_coverage": 96}');
		expect(await readSummary(root)).toEqual({
			linePercent: 96,
			coveredLines: null,
			totalLines: null,
			source: join(root, "nested/index.json"),
		});
	});

	test("aggregates per-target kcov count summaries", async () => {
		const root = await mkdtemp(join(tmpdir(), "coverage-summary-"));
		await mkdir(join(root, "target-a"), { recursive: true });
		await mkdir(join(root, "target-b"), { recursive: true });
		await writeFile(
			join(root, "target-a/coverage.json"),
			'{"covered_lines":80,"total_lines":100}',
		);
		await writeFile(
			join(root, "target-b/index.json"),
			'{"covered_lines":10,"total_lines":20}',
		);
		const summary = await readSummary(root);
		expect(summary.coveredLines).toBe(90);
		expect(summary.totalLines).toBe(120);
		expect(summary.linePercent).toBeCloseTo(75);
		expect(summary.source).toBe("merged:2");
	});

	test("deduplicates per-file kcov summaries across targets", async () => {
		const root = await mkdtemp(join(tmpdir(), "coverage-summary-"));
		await mkdir(join(root, "target-a"), { recursive: true });
		await mkdir(join(root, "target-b"), { recursive: true });
		await writeFile(
			join(root, "target-a/coverage.json"),
			JSON.stringify({
				files: [
					{ file: "/repo/src/a.zig", covered_lines: "5", total_lines: "10" },
					{ file: "/repo/src/b.zig", covered_lines: "7", total_lines: "7" },
				],
				percent_covered: "70",
				covered_lines: 12,
				total_lines: 17,
			}),
		);
		await writeFile(
			join(root, "target-b/coverage.json"),
			JSON.stringify({
				files: [
					{ file: "/repo/src/a.zig", covered_lines: "6", total_lines: "10" },
					{ file: "/repo/src/c.zig", covered_lines: "8", total_lines: "8" },
				],
				percent_covered: "77.77",
				covered_lines: 14,
				total_lines: 18,
			}),
		);
		const summary = await readSummary(root);
		expect(summary.coveredLines).toBe(21);
		expect(summary.totalLines).toBe(25);
		expect(summary.linePercent).toBeCloseTo(84);
		expect(summary.source).toBe("merged-files:3");
	});

	test("skips malformed candidate summaries and keeps usable ones", async () => {
		const root = await mkdtemp(join(tmpdir(), "coverage-summary-"));
		await mkdir(join(root, "nested"), { recursive: true });
		await writeFile(join(root, "coverage.json"), "{not-json");
		await writeFile(
			join(root, "nested/coverage.json"),
			'{"covered_lines":9,"total_lines":10}',
		);
		const summary = await readSummary(root);
		expect(summary.coveredLines).toBe(9);
		expect(summary.totalLines).toBe(10);
		expect(summary.linePercent).toBe(90);
	});
});
