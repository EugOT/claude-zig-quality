import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { repoRoot } from "../../scripts/lib/runtime.ts";
import {
	defaultLinuxCommand,
	orbCreateArgs,
	orbRunArgs,
	parseOrbStackArgs,
	shellQuote,
} from "../../scripts/orbstack-linux.ts";

describe("orbstack-linux command builder", () => {
	test("parses defaults and builds the standard Linux command", () => {
		const opts = parseOrbStackArgs(["--repo", "/tmp/repo"]);
		expect(opts.machine).toBe("zig-qm-arch");
		expect(opts.image).toBe("arch:current");
		expect(opts.command).toBe(defaultLinuxCommand("/tmp/repo"));
		expect(opts.command).toContain(
			'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"',
		);
		expect(opts.command).toContain(
			"export ZIG_QM_PLATFORM_LANE=orbstack-linux",
		);
		expect(opts.command).toContain("bun scripts/verify-pr.ts");
		expect(opts.command).toContain(
			"bun scripts/coverage-linux.ts --fail-under-lines 95",
		);
		expect(opts.command).not.toContain("--skip-missing-kcov");
		expect(opts.command).toContain("bun scripts/security-scan.ts");
	});

	test("parses create and dry-run flags", () => {
		const opts = parseOrbStackArgs([
			"--machine",
			"zq",
			"--image",
			"ubuntu:24.04",
			"--command",
			"echo ok",
			"--create",
			"--dry-run",
		]);
		expect(opts.machine).toBe("zq");
		expect(opts.image).toBe("ubuntu:24.04");
		expect(opts.command).toBe("echo ok");
		expect(opts.create).toBe(true);
		expect(opts.dryRun).toBe(true);
	});

	test("builds orb argv", () => {
		expect(orbCreateArgs({ image: "ubuntu:noble", machine: "zq" })).toEqual([
			"orb",
			"create",
			"ubuntu:noble",
			"zq",
		]);
		expect(orbRunArgs({ machine: "zq", command: "echo ok" })).toEqual([
			"orb",
			"-m",
			"zq",
			"bash",
			"-lc",
			"echo ok",
		]);
	});

	test("shellQuote handles single quotes", () => {
		expect(shellQuote("a'b")).toBe("'a'\\''b'");
	});

	test("Arch bootstrap template installs kcov", async () => {
		const text = await readFile(
			resolve(repoRoot(), "templates/orbstack/arch-kcov-bootstrap.bash"),
			"utf8",
		);
		expect(text).toContain("pacman -Sy --noconfirm --needed");
		expect(text).toContain("kcov");
		expect(text).toContain("mise use -g zig@0.16.0");
	});
});
