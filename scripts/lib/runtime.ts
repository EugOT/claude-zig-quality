/**
 * Shared runtime helpers for TS/Bun hooks and verify scripts.
 *
 * Keep this module dependency-free. Only Bun built-ins (`Bun.*`, `node:*`)
 * are allowed. Rationale: the v0 repo has no third-party dependencies so
 * `bun install` stays a no-op that only produces `bun.lock`.
 */
import { resolve } from "node:path";

export type HookVerdict =
	| { kind: "allow" }
	| { kind: "block"; reason: string; additionalContext?: string }
	| {
			kind: "pre-tool-decision";
			permissionDecision: "allow" | "deny" | "ask";
			permissionDecisionReason: string;
	  };

export function cpuCount(): number {
	// Prefer node:os in server-side Bun; navigator.hardwareConcurrency is
	// a browser shim that can be undefined or wrong in CI containers.
	try {
		const { cpus } = require("node:os") as typeof import("node:os");
		const n = cpus().length;
		return n > 0 ? n : 4;
	} catch {
		return 4;
	}
}

export function repoRoot(): string {
	const fromEnv = process.env.CLAUDE_PROJECT_DIR;
	if (fromEnv && fromEnv.length > 0) return resolve(fromEnv);
	const proc = Bun.spawnSync(["jj", "workspace", "root"], { stdout: "pipe" });
	if (proc.exitCode === 0) return proc.stdout.toString().trim();
	const git = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
		stdout: "pipe",
	});
	if (git.exitCode === 0) return git.stdout.toString().trim();
	return resolve(process.cwd());
}

/**
 * Emit a structured JSON verdict on stdout and exit with the right code.
 *
 * Exit-code semantics (from plan §2.1):
 * - 0 = allow, stdout parsed as JSON for decision control
 * - 2 = hard block, stderr is the reason fed back to the agent
 * - 1 = non-blocking warn, stderr visible in transcript only
 */
export function emitPreTool(v: HookVerdict): never {
	if (v.kind === "allow") {
		console.log(JSON.stringify({ continue: true }));
		process.exit(0);
	}
	if (v.kind === "pre-tool-decision") {
		console.log(
			JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "PreToolUse",
					permissionDecision: v.permissionDecision,
					permissionDecisionReason: v.permissionDecisionReason,
				},
			}),
		);
		process.exit(0);
	}
	// block
	console.error(v.reason);
	process.exit(2);
}

export function emitPostTool(v: HookVerdict): never {
	if (v.kind === "allow") {
		process.exit(0);
	}
	if (v.kind === "block") {
		console.log(
			JSON.stringify({
				decision: "block",
				reason: v.reason,
				...(v.additionalContext
					? {
							hookSpecificOutput: {
								hookEventName: "PostToolUse",
								additionalContext: v.additionalContext,
							},
						}
					: {}),
			}),
		);
		process.exit(0);
	}
	// pre-tool-decision on PostToolUse makes no sense; treat as allow
	process.exit(0);
}

/**
 * Read JSON from stdin. Claude Code pipes the hook payload here.
 * Timeouts and empty stdin both degrade to `{}`.
 */
export async function readStdinJson<T = unknown>(
	fallback: T = {} as T,
): Promise<T> {
	try {
		const text = await Bun.stdin.text();
		if (!text.trim()) return fallback;
		return JSON.parse(text) as T;
	} catch {
		return fallback;
	}
}

export type SpawnOpts = {
	cwd?: string;
	env?: Record<string, string>;
	stdin?: "inherit" | "ignore";
};

export type SpawnResult = {
	code: number | null;
	stdout: string;
	stderr: string;
};

export function spawnSync(cmd: string[], opts: SpawnOpts = {}): SpawnResult {
	const proc = Bun.spawnSync(cmd, {
		cwd: opts.cwd ?? repoRoot(),
		env: { ...process.env, ...(opts.env ?? {}) },
		stdout: "pipe",
		stderr: "pipe",
		stdin: opts.stdin ?? "ignore",
	});
	return {
		code: proc.exitCode,
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
	};
}

export type LogLine = Record<string, unknown> & {
	ts: string;
	event: string;
};

export async function appendJsonl(
	relPath: string,
	line: Omit<LogLine, "ts"> & { ts?: string },
): Promise<void> {
	const full = resolve(repoRoot(), relPath);
	const payload: LogLine = {
		ts: line.ts ?? new Date().toISOString(),
		...line,
	};
	const data = `${JSON.stringify(payload)}\n`;
	// Atomic O_APPEND via node:fs/promises so concurrent writers do not lose
	// data. The previous read-then-write was racy under the verify chain
	// (verify-fast → verify-commit → verify-pr each append independently).
	const { appendFile, mkdir } = await import("node:fs/promises");
	const { dirname } = await import("node:path");
	await mkdir(dirname(full), { recursive: true });
	await appendFile(full, data);
}

/**
 * Last-N-bytes tail for stderr that gets fed back to the agent. Keeps
 * context small and deterministic.
 */
export function tail(s: string, bytes = 2048): string {
	if (s.length <= bytes) return s;
	return `…\n${s.slice(s.length - bytes)}`;
}
