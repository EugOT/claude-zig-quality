import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertSafeCoverageOutput,
	buildKcovArgs,
	coverageStem,
	parseCoverageArgs,
	parseCoverageSummary,
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

	test("rejects dangerous output directories", () => {
		expect(() => resolveRepoChild("/repo", ".", "--output")).toThrow(
			"cannot be the repo root",
		);
		expect(() => resolveRepoChild("/repo", "..", "--output")).toThrow(
			"must stay inside the repository",
		);
		expect(resolveRepoChild("/repo", "zig-out/coverage", "--output")).toBe(
			"/repo/zig-out/coverage",
		);
	});

	test("rejects option-looking flag values", () => {
		expect(() =>
			parseCoverageArgs(["--summary-output", "--allow-non-linux"]),
		).toThrow("--summary-output requires a value");
	});

	test("summary output cannot escape generated summary locations", () => {
		expect(() => resolveSummaryOutput("/repo", "../summary.json")).toThrow(
			"must stay inside the repository",
		);
		expect(() => resolveSummaryOutput("/repo", "README.md")).toThrow(
			"must stay under coverage/",
		);
		expect(resolveSummaryOutput("/repo", "coverage/summary.json")).toBe(
			"/repo/coverage/summary.json",
		);
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
		expect(coverageStem("src/a/mod.zig")).toBe("src_a_mod");
		expect(coverageStem("src/b/mod.zig")).toBe("src_b_mod");
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

	test("returns null when no known coverage key exists", () => {
		expect(parseCoverageSummary('{"foo": 1}')).toEqual({
			linePercent: null,
			coveredLines: null,
			totalLines: null,
			source: "json",
		});
	});
});
