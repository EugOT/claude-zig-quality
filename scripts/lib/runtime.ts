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
	// Codex P1: Bun.spawnSync throws ENOENT (does not return a non-zero exit
	// code) when the binary is absent. Wrap each probe so a missing jj/git
	// falls through to the next candidate instead of crashing every verifier
	// that imports repoRoot() in git-only or tool-less environments.
	const trySpawn = (cmd: string[]): string | null => {
		try {
			const p = Bun.spawnSync(cmd, { stdout: "pipe" });
			return p.exitCode === 0 ? p.stdout.toString().trim() : null;
		} catch {
			return null;
		}
	};
	const jjRoot = trySpawn(["jj", "workspace", "root"]);
	if (jjRoot) return jjRoot;
	const gitRoot = trySpawn(["git", "rev-parse", "--show-toplevel"]);
	if (gitRoot) return gitRoot;
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
	// Bun.spawnSync THROWS (ENOENT) when the binary is absent from PATH — it does
	// not return a non-zero exit code (same Codex P1 finding repoRoot() guards).
	// Wrap it so a missing tool (jj/git/zig on a bare host) degrades to a 127
	// "command not found" result instead of crashing every caller — SessionStart
	// in particular must never fail (its contract: never block session start).
	try {
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
	} catch (err) {
		return { code: 127, stdout: "", stderr: String(err) };
	}
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
 * Last-N-characters tail for stderr that gets fed back to the agent. Keeps
 * context small and deterministic. Truncation is deliberately character-based
 * (UTF-16 code units via String.length/slice), not byte-based: byte slicing
 * could split a multi-byte UTF-8 sequence and feed invalid text back to the
 * agent. Worst case the tail spans ~4x the character count in bytes.
 */
export function tail(s: string, maxChars = 2048): string {
	if (s.length <= maxChars) return s;
	return `…\n${s.slice(s.length - maxChars)}`;
}

/**
 * Print a uniform gate-failure diagnostic: a `<label> failed (exit <code>)`
 * line followed by a tail of the merged stdout/stderr. Empty streams are
 * omitted from the blob so a fmt-only failure does not print a blank line.
 *
 * Lives in runtime.ts (not the individual verify-*.ts tiers) so every tier
 * shares one formatter and it is unit-testable with a console.error spy,
 * independent of any gate run.
 */
export function printFail(label: string, result: SpawnResult): void {
	console.error(`${label} failed (exit ${result.code ?? "?"})`);
	const blob = [result.stdout, result.stderr]
		.filter((s) => s.length > 0)
		.join("\n");
	if (blob.length > 0) console.error(tail(blob));
}
