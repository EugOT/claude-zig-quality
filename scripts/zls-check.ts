#!/usr/bin/env bun
/**
 * zls-check.ts — ZLS semantic-diagnostics gate (per-PR tier).
 *
 * Boots the pinned ZLS, opens every tracked `src/**\/*.zig` (or the paths
 * passed as args), collects pushed diagnostics, and fails on any
 * Error-severity diagnostic. This is an ADDITIVE layer over `zig ast-check`
 * (per-turn: syntax, unused, shadowing) and `zig build test` (per-PR: full
 * compile errors); it surfaces ZLS's per-file semantic analysis plus, when a
 * pinned zig is wired, its build-on-save diagnostics.
 *
 * Resilience contract (per project policy: maximum resilience + explicit
 * degradation, never a silent gap):
 *   - No pinned ZLS resolvable  → degrade LOUDLY to a skip notice, exit 0.
 *     (ast-check + build test still cover the essentials.)
 *   - ZLS unreachable / a file never reports within the budget → FAIL: a
 *     missing diagnostic is treated as a gate failure, not a pass, so the
 *     gate never silently goes green on a server that died.
 *   - Error-severity diagnostics → FAIL with file:line:message.
 *   - Warnings/info/hints → reported, non-fatal.
 *
 * Exit codes: 0 = pass (or explicit skip), 1 = real failure.
 *
 * Untrusted-data boundary: ZLS diagnostic text is data. It is printed for the
 * operator; it never alters control flow beyond pass/fail on severity.
 */
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Glob } from "bun";
import { repoRoot } from "./lib/runtime.ts";
import { zigExePath, zlsLaunchArgv, zlsMessage } from "./lib/zig.ts";
import { collectZlsDiagnostics } from "./lib/zls.ts";

export async function resolveFiles(
	root: string,
	argv: string[],
): Promise<string[]> {
	if (argv.length > 0) {
		return argv.map((p) => resolve(root, p));
	}
	// Default surface: every .zig under src/. (scripts/*.zig are run-once
	// AST tools, not part of the library surface ZLS should diagnose.)
	const glob = new Glob("src/**/*.zig");
	const files: string[] = [];
	for await (const rel of glob.scan({ cwd: root })) {
		files.push(resolve(root, rel));
	}
	files.sort();
	return files;
}

export async function main(): Promise<void> {
	const timeoutMs = Number(process.env.ZLS_TIMEOUT_MS ?? "60000");
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		console.error(
			`zls-check: invalid ZLS_TIMEOUT_MS=${JSON.stringify(process.env.ZLS_TIMEOUT_MS)}; ` +
				"must be a positive number of milliseconds.",
		);
		process.exit(1);
	}

	const root = repoRoot();
	const launchArgv = zlsLaunchArgv();

	if (launchArgv === null) {
		// Explicit degradation — the green gate on a ZLS-less host says so.
		console.log(zlsMessage());
		process.exit(0);
	}

	const files = await resolveFiles(root, process.argv.slice(2));
	if (files.length === 0) {
		console.log("zls-check: no .zig files to diagnose");
		process.exit(0);
	}

	console.log(`== ZLS semantic diagnostics (${files.length} file(s)) ==`);
	const zigPath = zigExePath() ?? undefined;
	if (zigPath) {
		console.log(`(build-on-save enabled via pinned zig: ${zigPath})`);
	} else {
		console.log(
			"(zero-config ast-check tier only; no pinned zig for build-on-save)",
		);
	}

	const result = await collectZlsDiagnostics({
		launchArgv,
		files,
		timeoutMs,
		zigExePath: zigPath,
		rootUri: pathToFileURL(`${root}/`).href,
	});

	let errorCount = 0;
	let warnCount = 0;
	for (const [file, diags] of result.byFile) {
		for (const d of diags) {
			const sev = d.severity ?? 1;
			const line = d.range.start.line + 1; // LSP is 0-based
			const col = d.range.start.character + 1;
			const tag = sev === 1 ? "error" : sev === 2 ? "warning" : "info";
			// path.relative handles separator boundaries correctly — a naive
			// startsWith+slice mis-slices when an arg shares a prefix with root
			// but sits outside it (e.g. /repo vs /repox/foo.zig) (CodeRabbit).
			const rel = relative(root, file);
			const msg = `${rel}:${line}:${col}: ${tag}: ${d.message} [${d.source ?? "zls"}]`;
			if (sev === 1) {
				console.error(msg);
				errorCount++;
			} else if (sev === 2) {
				console.error(msg);
				warnCount++;
			} else {
				console.log(msg);
			}
		}
	}

	// Fail-closed on a server that never reported for a file: a missing
	// diagnostic is NOT a pass. Distinguish a timeout (server too slow) from
	// a clean "every file reported".
	if (result.unreported.length > 0) {
		console.error(
			`zls-check: ZLS did not report diagnostics for ${result.unreported.length} ` +
				`file(s)${result.timedOut ? " (hard timeout elapsed)" : ""}: ` +
				result.unreported.join(", "),
		);
		console.error(
			"Treating missing diagnostics as a failure (the gate must not go " +
				"silently green on an unresponsive server). Re-run; if it persists, " +
				"raise ZLS_TIMEOUT_MS or check the pinned zls@0.16.0 install.",
		);
		process.exit(1);
	}

	if (errorCount > 0) {
		console.error(
			`zls-check: ${errorCount} error-severity diagnostic(s)` +
				(warnCount > 0 ? `, ${warnCount} warning(s)` : ""),
		);
		process.exit(1);
	}

	console.log(
		`zls-check: OK (0 errors${warnCount > 0 ? `, ${warnCount} warning(s)` : ""})`,
	);
	process.exit(0);
}

if (import.meta.main) await main();
