#!/usr/bin/env bun
/**
 * doc-coverage.ts — doc-coverage gate (per-PR tier).
 *
 * Runs scripts/zig-doc-coverage.zig over every `src/**\/*.zig` (or the paths
 * passed as args) and fails if any top-level `pub` declaration lacks a `///`
 * doc comment (TIGER_STYLE_ZIG §10). The Zig tool does the AST work; this TS
 * wrapper resolves the toolchain (via lib/zig.ts), fans out per file, and
 * aggregates the verdict — the same split as check-public-api.ts over
 * zig-api-surface.zig.
 *
 * Exit codes: 0 = every public decl documented, 1 = at least one undocumented
 * decl or a tool error.
 */
import { resolve } from "node:path";
import { Glob } from "bun";
import { repoRoot } from "./lib/runtime.ts";
import { zig } from "./lib/zig.ts";

const TOOL = "scripts/zig-doc-coverage.zig";

async function resolveFiles(root: string, argv: string[]): Promise<string[]> {
	if (argv.length > 0) return argv.map((p) => resolve(root, p));
	const glob = new Glob("src/**/*.zig");
	const files: string[] = [];
	// Resolve to absolute against the repo root — the glob yields paths
	// relative to `cwd: root`, but the zig tool is spawned with the caller's
	// cwd, so relative paths would break when invoked from a subdirectory
	// (matches zls-check.ts's resolveFiles).
	for await (const rel of glob.scan({ cwd: root })) {
		files.push(resolve(root, rel));
	}
	files.sort();
	return files;
}

async function main(): Promise<void> {
	const root = repoRoot();
	const files = await resolveFiles(root, process.argv.slice(2));
	if (files.length === 0) {
		console.log("doc-coverage: no .zig files to check");
		process.exit(0);
	}

	let failures = 0;
	for (const file of files) {
		// `zig run <tool> -- <file>`: the tool prints violations to stderr and
		// exits 1 when any pub decl is undocumented.
		const r = zig(["run", TOOL, "--", file]);
		process.stdout.write(r.stdout);
		process.stderr.write(r.stderr);
		if (r.code !== 0) failures++;
	}

	if (failures > 0) {
		console.error(
			`doc-coverage: ${failures} file(s) with undocumented public declarations (TIGER_STYLE_ZIG §10)`,
		);
		process.exit(1);
	}
	console.log(
		`doc-coverage: OK (${files.length} file(s), every pub decl documented)`,
	);
	process.exit(0);
}

await main();
