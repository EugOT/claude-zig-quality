#!/usr/bin/env bun
import { resolve } from "node:path";
import { repoRoot, spawnSync } from "./lib/runtime.ts";

const DEFAULT_IMAGE = "claude-zig-quality-kcov:zig0.16-bun1.3.0";
const DOCKERFILE = "docker/coverage.Dockerfile";
const DOCKER_INFO_TIMEOUT_MS = 30_000;
const DOCKER_BUILD_TIMEOUT_MS = 600_000;
const DOCKER_RUN_TIMEOUT_MS = 600_000;

export type CoverageDockerArgs = {
	build: boolean;
	failUnderLines: string;
	image: string;
	platform?: string;
};

function takeValue(argv: string[], index: number, flag: string): string {
	const value = argv[index + 1];
	if (!value || value.startsWith("--"))
		throw new Error(`${flag} requires a value`);
	return value;
}

export function envOrDefault(
	value: string | undefined,
	fallback: string,
): string {
	return value && value.length > 0 ? value : fallback;
}

export function parseCoverageDockerArgs(argv: string[]): CoverageDockerArgs {
	const args: CoverageDockerArgs = {
		build: !argv.includes("--no-build"),
		failUnderLines: envOrDefault(process.env.ZIG_QM_COVERAGE_THRESHOLD, "95"),
		image: envOrDefault(process.env.ZIG_QM_COVERAGE_IMAGE, DEFAULT_IMAGE),
		platform: process.env.ZIG_QM_COVERAGE_PLATFORM || undefined,
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "--fail-under-lines":
			case "--threshold":
				args.failUnderLines = takeValue(argv, i, arg);
				i++;
				break;
			case "--image":
				args.image = takeValue(argv, i, arg);
				i++;
				break;
			case "--platform":
				args.platform = takeValue(argv, i, arg);
				i++;
				break;
			case "--no-build":
				break;
			case "--help":
			case "-h":
				printHelp();
				process.exit(0);
				return;
			default:
				throw new Error(`unknown argument: ${arg}`);
		}
	}

	return args;
}

function printHelp(): void {
	console.log(`Usage:
  bun scripts/coverage-docker.ts [--fail-under-lines 95] [--platform linux/arm64] [--image <tag>] [--no-build]

Builds and runs the repo-owned kcov image. This is the reproducible local
Docker/OrbStack lane and the CI fallback when the host image does not provide
kcov.`);
}

function requireDocker(): void {
	if (Bun.which("docker") === null) {
		throw new Error(
			"docker was not found on PATH; start OrbStack or use a Docker-capable CI runner.",
		);
	}
	const info = spawnSync(
		["docker", "info", "--format", "{{.OperatingSystem}}"],
		{ timeout: DOCKER_INFO_TIMEOUT_MS },
	);
	if (info.code !== 0) {
		throw new Error(
			`docker daemon is unavailable:\n${info.stderr || info.stdout}`,
		);
	}
}

function buildImage(root: string, args: CoverageDockerArgs): void {
	const dockerfile = resolve(root, DOCKERFILE);
	const cmd = ["docker", "build", "-f", dockerfile, "-t", args.image];
	if (args.platform) cmd.push("--platform", args.platform);
	cmd.push(resolve(root, "docker"));
	const result = spawnSync(cmd, {
		cwd: root,
		timeout: DOCKER_BUILD_TIMEOUT_MS,
	});
	process.stdout.write(result.stdout);
	process.stderr.write(result.stderr);
	if (result.timedOut) {
		throw new Error(
			`docker build timed out after ${DOCKER_BUILD_TIMEOUT_MS}ms`,
		);
	}
	if (result.code !== 0) {
		throw new Error(`docker build failed with exit ${result.code}`);
	}
}

export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildRunCommand(
	root: string,
	args: CoverageDockerArgs,
	containerName: string,
	uid: number,
	gid: number,
): string[] {
	const inner = [
		"set -euo pipefail",
		'mkdir -p "$HOME" "$BUN_INSTALL_CACHE_DIR" "$XDG_CACHE_HOME"',
		"bun ci",
		"bun scripts/coverage-linux.ts --fail-under-lines " +
			shellQuote(args.failUnderLines),
	].join("; ");
	const lane = process.env.CI ? "ci-linux" : "orbstack-linux";
	// kcov needs ptrace support, so this coverage-only container disables the
	// default seccomp profile. The run stays scoped to the repo mount and host
	// uid/gid instead of running as root.
	const cmd = [
		"docker",
		"run",
		"--rm",
		"--name",
		containerName,
		"--init",
		"--cpus",
		"2",
		"--memory",
		"2g",
		"--cap-add",
		"SYS_PTRACE",
		"--security-opt",
		"seccomp=unconfined",
		"--user",
		`${uid}:${gid}`,
		"-e",
		"HOME=/tmp/zig-quality-coverage-home",
		"-e",
		"BUN_INSTALL_CACHE_DIR=/tmp/bun-cache",
		"-e",
		"XDG_CACHE_HOME=/tmp/xdg-cache",
		"-e",
		"ZIG=/usr/local/bin/zig",
		"-e",
		`ZIG_QM_PLATFORM_LANE=${process.env.ZIG_QM_PLATFORM_LANE ?? lane}`,
		"-v",
		`${root}:/work`,
		"-w",
		"/work",
	];
	if (args.platform) cmd.push("--platform", args.platform);
	cmd.push(args.image, "bash", "-lc", inner);
	return cmd;
}

function runCoverage(root: string, args: CoverageDockerArgs): number {
	const uid = process.getuid?.() ?? 1000;
	const gid = process.getgid?.() ?? 1000;
	const containerName = `zq-coverage-${process.pid}-${Date.now()}`;
	const cmd = buildRunCommand(root, args, containerName, uid, gid);
	const result = spawnSync(cmd, { cwd: root, timeout: DOCKER_RUN_TIMEOUT_MS });
	process.stdout.write(result.stdout);
	process.stderr.write(result.stderr);
	if (result.timedOut) {
		console.error(`docker run timed out after ${DOCKER_RUN_TIMEOUT_MS}ms`);
		const cleaned = spawnSync(["docker", "rm", "-f", containerName], {
			cwd: root,
			timeout: DOCKER_INFO_TIMEOUT_MS,
		});
		process.stdout.write(cleaned.stdout);
		process.stderr.write(cleaned.stderr);
		return 124;
	}
	return result.code ?? 1;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
	const args = parseCoverageDockerArgs(argv);
	const root = repoRoot();
	requireDocker();
	if (args.build) buildImage(root, args);
	return runCoverage(root, args);
}

if (import.meta.main) {
	try {
		process.exit(await main());
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}
