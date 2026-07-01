import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	gitMetadataMount,
	parseCoverageDockerArgs,
	shellQuote,
} from "../../scripts/coverage-docker.ts";
import { spawnSync } from "../../scripts/lib/runtime.ts";

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

	test("gitMetadataMount skips non-repos", async () => {
		const root = await mkdtemp(join(tmpdir(), "coverage-docker-nonrepo-"));
		expect(gitMetadataMount(root)).toEqual([]);
	});

	test("gitMetadataMount skips git dirs nested under the mounted repo", async () => {
		const root = await mkdtemp(join(tmpdir(), "coverage-docker-repo-"));
		spawnSync(["git", "init"], { cwd: root });
		expect(gitMetadataMount(root)).toEqual([]);
	});

	test("gitMetadataMount mounts external git dirs", async () => {
		const root = await mkdtemp(join(tmpdir(), "coverage-docker-worktree-"));
		const gitDir = await mkdtemp(join(tmpdir(), "coverage-docker-gitdir-"));
		spawnSync(["git", "init", "--separate-git-dir", gitDir, root], {
			cwd: tmpdir(),
		});
		const mounted = await realpath(gitDir);
		expect(gitMetadataMount(root)).toEqual(["-v", `${mounted}:${mounted}:ro`]);
	});
});
