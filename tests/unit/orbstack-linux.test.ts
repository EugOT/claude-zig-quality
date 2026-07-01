import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { repoRoot } from "../../scripts/lib/runtime.ts";
import {
	defaultLinuxCommand,
	imageHasKcov,
	orbCreateAlreadyExists,
	orbCreateArgs,
	orbRunArgs,
	parseOrbStackArgs,
	shellQuote,
} from "../../scripts/orbstack-linux.ts";

describe("orbstack-linux command builder", () => {
	test("parses defaults and builds the standard Linux command", () => {
		const savedMachine = process.env.ZIG_QM_ORBSTACK_MACHINE;
		const savedImage = process.env.ZIG_QM_ORBSTACK_IMAGE;
		delete process.env.ZIG_QM_ORBSTACK_MACHINE;
		delete process.env.ZIG_QM_ORBSTACK_IMAGE;
		try {
			const opts = parseOrbStackArgs(["--repo", "/tmp/repo"]);
			expect(opts.machine).toBe("zig-qm-arch");
			expect(opts.image).toBe(
				"archlinux:base@sha256:068a765646e75e51fe5d544b0f95c85d0322d0a372659e9d5f10fb8402ca53f1",
			);
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
		} finally {
			if (savedMachine === undefined)
				delete process.env.ZIG_QM_ORBSTACK_MACHINE;
			else process.env.ZIG_QM_ORBSTACK_MACHINE = savedMachine;
			if (savedImage === undefined) delete process.env.ZIG_QM_ORBSTACK_IMAGE;
			else process.env.ZIG_QM_ORBSTACK_IMAGE = savedImage;
		}
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

	test("omits advisory coverage for Ubuntu default commands", () => {
		const opts = parseOrbStackArgs([
			"--repo",
			"/tmp/repo",
			"--image",
			"ubuntu:noble",
		]);
		expect(imageHasKcov(opts.image)).toBe(false);
		expect(opts.command).toBe(
			defaultLinuxCommand("/tmp/repo", { coverage: false }),
		);
		expect(opts.command).not.toContain("bun scripts/coverage-linux.ts");
		expect(opts.command).toContain("skipping coverage-linux.ts");
		expect(opts.command).toContain("bun scripts/security-scan.ts");
	});

	test("enables coverage only for known kcov-capable images", () => {
		expect(
			imageHasKcov(
				"archlinux:base@sha256:068a765646e75e51fe5d544b0f95c85d0322d0a372659e9d5f10fb8402ca53f1",
			),
		).toBe(true);
		expect(imageHasKcov("archlinux:base")).toBe(true);
		expect(imageHasKcov("debian:stable")).toBe(false);
		expect(imageHasKcov("ubuntu:noble")).toBe(false);
	});

	test("allows option-looking command payloads", () => {
		const opts = parseOrbStackArgs(["--command", "--version"]);
		expect(opts.command).toBe("--version");
	});

	test("rejects option-looking values", () => {
		expect(() => parseOrbStackArgs(["--machine", "--dry-run"])).toThrow(
			"--machine requires a value",
		);
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

	test("recognizes idempotent orb create errors", () => {
		expect(orbCreateAlreadyExists("machine zig-qm-arch already exists")).toBe(
			true,
		);
		expect(orbCreateAlreadyExists("permission denied")).toBe(false);
	});

	test("Arch bootstrap template installs kcov", async () => {
		const text = await readFile(
			resolve(repoRoot(), "templates/orbstack/arch-kcov-bootstrap.bash"),
			"utf8",
		);
		expect(text).toContain("pacman -Syu --noconfirm --needed");
		expect(text).toContain("kcov");
		expect(text).toContain("mise use -g zig@0.16.0");
		expect(text.indexOf("export PATH=")).toBeLessThan(
			text.indexOf("command -v mise"),
		);
	});

	test("Ubuntu cloud-init template keeps coverage advisory", async () => {
		const text = await readFile(
			resolve(repoRoot(), "templates/orbstack/ubuntu-noble-cloud-init.yaml"),
			"utf8",
		);
		expect(text).toContain(
			'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"',
		);
		expect(text).toContain("#cloud-config");
		expect(text).toContain("set ORBSTACK_LOGIN_USER");
		expect(text).toContain('login_user="$ORBSTACK_LOGIN_USER"');
		expect(text).toContain("does not exist");
		expect(text).toContain('sudo -H -u "$login_user"');
		expect(text).toContain("command -v mise");
		expect(text).toContain("command -v bun");
		expect(text).toContain("command -v mise || {");
		expect(text).toContain("command -v bun || {");
		expect(text).toContain("mise use -g zig@0.16.0");
		expect(text).toContain("kcov is intentionally not listed");
		expect(text).not.toContain("  - kcov");
	});
});
