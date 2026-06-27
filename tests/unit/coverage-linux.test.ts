import { describe, expect, test } from "bun:test";
import {
	buildKcovArgs,
	parseCoverageArgs,
	parseCoverageSummary,
	zigTestCompileArgs,
} from "../../scripts/coverage-linux.ts";

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
		expect(zigTestCompileArgs("src/a.zig", "out/a-test")).toEqual([
			"mise",
			"x",
			"zig@0.16.0",
			"--",
			"zig",
			"test",
			"src/a.zig",
			"--test-no-exec",
			"-femit-bin=out/a-test",
		]);
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
