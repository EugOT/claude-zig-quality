import { describe, expect, test } from "bun:test";
import {
	buildRunCommand,
	envOrDefault,
	parseCoverageDockerArgs,
	shellQuote,
} from "../../scripts/coverage-docker.ts";

describe("coverage-docker argument parsing", () => {
	test("uses fail-closed measured coverage defaults", () => {
		const savedThreshold = process.env.ZIG_QM_COVERAGE_THRESHOLD;
		const savedImage = process.env.ZIG_QM_COVERAGE_IMAGE;
		const savedPlatform = process.env.ZIG_QM_COVERAGE_PLATFORM;
		delete process.env.ZIG_QM_COVERAGE_THRESHOLD;
		delete process.env.ZIG_QM_COVERAGE_IMAGE;
		delete process.env.ZIG_QM_COVERAGE_PLATFORM;
		try {
			const opts = parseCoverageDockerArgs([]);
			expect(opts.build).toBe(true);
			expect(opts.failUnderLines).toBe("95");
			expect(opts.image).toBe("claude-zig-quality-kcov:zig0.16-bun1.3.0");
			expect(opts.platform).toBeUndefined();
		} finally {
			if (savedThreshold === undefined)
				delete process.env.ZIG_QM_COVERAGE_THRESHOLD;
			else process.env.ZIG_QM_COVERAGE_THRESHOLD = savedThreshold;
			if (savedImage === undefined) delete process.env.ZIG_QM_COVERAGE_IMAGE;
			else process.env.ZIG_QM_COVERAGE_IMAGE = savedImage;
			if (savedPlatform === undefined)
				delete process.env.ZIG_QM_COVERAGE_PLATFORM;
			else process.env.ZIG_QM_COVERAGE_PLATFORM = savedPlatform;
		}
	});

	test("treats empty environment defaults as unset", () => {
		expect(envOrDefault("", "fallback")).toBe("fallback");
		expect(envOrDefault(undefined, "fallback")).toBe("fallback");
		expect(envOrDefault("value", "fallback")).toBe("value");
		const savedThreshold = process.env.ZIG_QM_COVERAGE_THRESHOLD;
		const savedImage = process.env.ZIG_QM_COVERAGE_IMAGE;
		const savedPlatform = process.env.ZIG_QM_COVERAGE_PLATFORM;
		process.env.ZIG_QM_COVERAGE_THRESHOLD = "";
		process.env.ZIG_QM_COVERAGE_IMAGE = "";
		process.env.ZIG_QM_COVERAGE_PLATFORM = "";
		try {
			const opts = parseCoverageDockerArgs([]);
			expect(opts.failUnderLines).toBe("95");
			expect(opts.image).toBe("claude-zig-quality-kcov:zig0.16-bun1.3.0");
			expect(opts.platform).toBeUndefined();
		} finally {
			if (savedThreshold === undefined)
				delete process.env.ZIG_QM_COVERAGE_THRESHOLD;
			else process.env.ZIG_QM_COVERAGE_THRESHOLD = savedThreshold;
			if (savedImage === undefined) delete process.env.ZIG_QM_COVERAGE_IMAGE;
			else process.env.ZIG_QM_COVERAGE_IMAGE = savedImage;
			if (savedPlatform === undefined)
				delete process.env.ZIG_QM_COVERAGE_PLATFORM;
			else process.env.ZIG_QM_COVERAGE_PLATFORM = savedPlatform;
		}
	});

	test("parses image, platform, no-build, and threshold aliases", () => {
		const opts = parseCoverageDockerArgs([
			"--image",
			"local/image",
			"--platform",
			"linux/arm64",
			"--threshold",
			"90",
			"--no-build",
		]);
		expect(opts).toEqual({
			build: false,
			failUnderLines: "90",
			image: "local/image",
			platform: "linux/arm64",
		});
	});

	test("throws on unknown argument", () => {
		expect(() => parseCoverageDockerArgs(["--bogus"])).toThrow(
			"unknown argument: --bogus",
		);
	});

	test("throws when a flag is missing its value", () => {
		expect(() => parseCoverageDockerArgs(["--image"])).toThrow(
			"--image requires a value",
		);
		expect(() => parseCoverageDockerArgs(["--platform", "--no-build"])).toThrow(
			"--platform requires a value",
		);
	});

	test("shellQuote protects shell metacharacters", () => {
		expect(shellQuote("")).toBe("''");
		expect(shellQuote("a'b")).toBe("'a'\\''b'");
		expect(shellQuote("95; rm -rf /")).toBe("'95; rm -rf /'");
	});

	test("builds the bounded Docker run command with security flags", () => {
		const cmd = buildRunCommand(
			"/repo",
			{
				build: false,
				failUnderLines: "95",
				image: "local/image",
				platform: "linux/arm64",
			},
			"zq-test",
			501,
			20,
		);
		expect(cmd).toContain("--name");
		expect(cmd).toContain("zq-test");
		expect(cmd).toContain("--cpus");
		expect(cmd).toContain("2");
		expect(cmd).toContain("--memory");
		expect(cmd).toContain("2g");
		expect(cmd).toContain("--cap-add");
		expect(cmd).toContain("SYS_PTRACE");
		expect(cmd).toContain("--security-opt");
		expect(cmd).toContain("seccomp=unconfined");
		expect(cmd).toContain("--user");
		expect(cmd).toContain("501:20");
		expect(cmd).toContain("--platform");
		expect(cmd).toContain("linux/arm64");
		expect(cmd).toContain("local/image");
		expect(cmd.at(-1)).toContain("coverage-linux.ts --fail-under-lines '95'");
		expect(cmd.at(-1)).not.toContain("bun ci");
	});
});
