import { describe, expect, test } from "bun:test";
import { parseCoverageDockerArgs } from "../../scripts/coverage-docker.ts";

describe("coverage-docker argument parsing", () => {
	test("uses fail-closed measured coverage defaults", () => {
		const opts = parseCoverageDockerArgs([]);
		expect(opts.build).toBe(true);
		expect(opts.failUnderLines).toBe("95");
		expect(opts.image).toBe("claude-zig-quality-kcov:zig0.16-bun1.3.0");
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
});
