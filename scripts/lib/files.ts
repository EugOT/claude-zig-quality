/**
 * Safe file walking for the verify runtime. Prefers `jj files` when
 * available (fastest, ignores what jj ignores) then falls back to
 * `git ls-files` and finally to a filesystem walk.
 */

import { existsSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { repoRoot, spawnSync } from "./runtime.ts";

const CANDIDATE_DIRS = [
	"build.zig",
	"build.zig.zon",
	"src",
	"tests",
	"test",
	"examples",
	"benches",
	"scripts",
];

export function collectZigInputs(root = repoRoot()): {
	fmtInputs: string[];
	zigFiles: string[];
} {
	// existsSync/statSync from node:fs handle directories reliably; the prior
	// Bun.file(...).size >= 0 form throws on directories (CodeRabbit finding).
	const roots = CANDIDATE_DIRS.map((d) => resolve(root, d)).filter((p) =>
		existsSync(p),
	);
	if (roots.length === 0) return { fmtInputs: [], zigFiles: [] };

	// Try jj first
	const jj = spawnSync(
		[
			"jj",
			"files",
			"--",
			...CANDIDATE_DIRS.filter((d) => existsRelaxed(resolve(root, d))),
		],
		{ cwd: root },
	);
	let tracked: string[] = [];
	if (jj.code === 0 && jj.stdout.trim().length > 0) {
		tracked = jj.stdout.split("\n").filter((l) => l.length > 0);
	} else {
		const git = spawnSync(
			[
				"git",
				"ls-files",
				...CANDIDATE_DIRS.filter((d) => existsRelaxed(resolve(root, d))),
			],
			{ cwd: root },
		);
		if (git.code === 0 && git.stdout.trim().length > 0) {
			tracked = git.stdout.split("\n").filter((l) => l.length > 0);
		}
	}

	if (tracked.length === 0) {
		// Fallback: direct filesystem walk (used only on a repo with no commits yet)
		return fsWalk(root);
	}

	const abs = tracked.map((p) => resolve(root, p));
	const fmtInputs = abs.filter((p) => {
		const ext = extname(p);
		return ext === ".zig" || ext === ".zon";
	});
	const zigFiles = abs.filter((p) => extname(p) === ".zig");
	return { fmtInputs, zigFiles };
}

function existsRelaxed(path: string): boolean {
	return existsSync(path);
}

function fsWalk(root: string): { fmtInputs: string[]; zigFiles: string[] } {
	const out: string[] = [];
	const { Glob } = Bun;
	for (const name of CANDIDATE_DIRS) {
		const p = resolve(root, name);
		if (!existsRelaxed(p)) continue;
		let isDir = false;
		try {
			isDir = statSync(p).isDirectory();
		} catch {
			isDir = false;
		}
		if (isDir) {
			const glob = new Glob("**/*.{zig,zon}");
			for (const q of glob.scanSync({ cwd: p, absolute: true })) {
				out.push(q);
			}
		} else if (p.endsWith(".zig") || p.endsWith(".zon")) {
			// It's a top-level single file like build.zig / build.zig.zon
			out.push(p);
		}
	}
	return {
		fmtInputs: out,
		zigFiles: out.filter((p) => extname(p) === ".zig"),
	};
}
