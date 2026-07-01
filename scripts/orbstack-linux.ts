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
// Keep this image reference in sync with the documented `orb create` example in
// templates/orbstack/arch-kcov-bootstrap.bash.
const DEFAULT_IMAGE =
	"archlinux:base@sha256:068a765646e75e51fe5d544b0f95c85d0322d0a372659e9d5f10fb8402ca53f1";
const ORBSTACK_CREATE_TIMEOUT_MS = 300_000;
const ORBSTACK_RUN_TIMEOUT_MS = 900_000;

export function imageHasKcov(image: string): boolean {
	return !/^ubuntu(?::|@)/.test(image);
}

export function defaultLinuxCommand(
	repo: string,
	opts: { coverage: boolean } = { coverage: true },
): string {
	const commands = [
		'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"',
		"export ZIG_QM_PLATFORM_LANE=orbstack-linux",
		`cd ${shellQuote(repo)}`,
		"bun install --frozen-lockfile",
		"bun scripts/verify-pr.ts",
	];
	if (opts.coverage)
		commands.push("bun scripts/coverage-linux.ts --fail-under-lines 95");
	commands.push("bun scripts/security-scan.ts");
	return commands.join(" && ");
}

function takeValue(
	argv: string[],
	index: number,
	flag: string,
	opts: { allowOptionLike?: boolean } = {},
): string {
	const value = argv[index + 1];
	if (!value || (!opts.allowOptionLike && value.startsWith("--")))
		throw new Error(`${flag} requires a value`);
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
				command = takeValue(argv, i, arg, { allowOptionLike: true });
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
		command:
			command || defaultLinuxCommand(repo, { coverage: imageHasKcov(image) }),
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

export function orbCreateAlreadyExists(output: string): boolean {
	return /already exists|exists already|machine .* exists/i.test(output);
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
			const created = spawnSync(createCmd, {
				timeout: ORBSTACK_CREATE_TIMEOUT_MS,
			});
			process.stdout.write(created.stdout);
			process.stderr.write(created.stderr);
			if (created.timedOut) {
				console.error(
					`orbstack-linux: orb create timed out after ${ORBSTACK_CREATE_TIMEOUT_MS}ms`,
				);
				process.exit(124);
			}
			if (created.code !== 0) {
				const combined = `${created.stdout}\n${created.stderr}`;
				if (orbCreateAlreadyExists(combined)) {
					console.error("orbstack-linux: machine already exists; continuing");
				} else {
					process.exit(created.code ?? 1);
				}
			}
		}
	}

	const runCmd = orbRunArgs(opts);
	if (opts.dryRun) {
		printCommand(runCmd);
		return;
	}
	const run = spawnSync(runCmd, { timeout: ORBSTACK_RUN_TIMEOUT_MS });
	process.stdout.write(run.stdout);
	process.stderr.write(run.stderr);
	if (run.timedOut) {
		console.error(
			`orbstack-linux: orb run timed out after ${ORBSTACK_RUN_TIMEOUT_MS}ms`,
		);
		process.exit(124);
	}
	process.exit(run.code ?? 1);
}

if (import.meta.main) await main();
