#!/usr/bin/env bun
import { repoRoot, spawnSync } from "./lib/runtime.ts";

export type OrbStackOptions = {
	machine: string;
	image: string;
	repo: string;
	command: string;
	create: boolean;
	dryRun: boolean;
};

const DEFAULT_MACHINE = "zig-qm-arch";
const DEFAULT_IMAGE = "arch:current";

export function defaultLinuxCommand(repo: string): string {
	return [
		'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"',
		"export ZIG_QM_PLATFORM_LANE=orbstack-linux",
		`cd ${shellQuote(repo)}`,
		"bun install --frozen-lockfile",
		"bun scripts/verify-pr.ts",
		"bun scripts/coverage-linux.ts --fail-under-lines 95",
		"bun scripts/security-scan.ts",
	].join(" && ");
}

function takeValue(argv: string[], index: number, flag: string): string {
	const value = argv[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
	return value;
}

export function parseOrbStackArgs(argv: string[]): OrbStackOptions {
	let machine = process.env.ZIG_QM_ORBSTACK_MACHINE || DEFAULT_MACHINE;
	let image = process.env.ZIG_QM_ORBSTACK_IMAGE || DEFAULT_IMAGE;
	let repo = repoRoot();
	let command = "";
	let create = false;
	let dryRun = false;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "--machine":
				machine = takeValue(argv, i, arg);
				i++;
				break;
			case "--image":
				image = takeValue(argv, i, arg);
				i++;
				break;
			case "--repo":
				repo = takeValue(argv, i, arg);
				i++;
				break;
			case "--command":
				command = takeValue(argv, i, arg);
				i++;
				break;
			case "--create":
				create = true;
				break;
			case "--dry-run":
				dryRun = true;
				break;
			default:
				throw new Error(`unknown argument: ${arg}`);
		}
	}

	return {
		machine,
		image,
		repo,
		command: command || defaultLinuxCommand(repo),
		create,
		dryRun,
	};
}

export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export function orbCreateArgs(
	opts: Pick<OrbStackOptions, "image" | "machine">,
): string[] {
	return ["orb", "create", opts.image, opts.machine];
}

export function orbRunArgs(
	opts: Pick<OrbStackOptions, "machine" | "command">,
): string[] {
	return ["orb", "-m", opts.machine, "bash", "-lc", opts.command];
}

function printCommand(cmd: string[]): void {
	console.log(cmd.map(shellQuote).join(" "));
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
	const opts = parseOrbStackArgs(argv);
	if (!opts.dryRun && Bun.which("orb") === null) {
		console.error("orbstack-linux: orb CLI not found on PATH");
		process.exit(127);
	}

	if (opts.create) {
		const createCmd = orbCreateArgs(opts);
		if (opts.dryRun) printCommand(createCmd);
		else {
			const created = spawnSync(createCmd);
			process.stdout.write(created.stdout);
			process.stderr.write(created.stderr);
			if (created.code !== 0) process.exit(created.code ?? 1);
		}
	}

	const runCmd = orbRunArgs(opts);
	if (opts.dryRun) {
		printCommand(runCmd);
		return;
	}
	const run = spawnSync(runCmd);
	process.stdout.write(run.stdout);
	process.stderr.write(run.stderr);
	process.exit(run.code ?? 1);
}

if (import.meta.main) await main();
