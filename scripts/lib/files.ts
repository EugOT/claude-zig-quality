/**
 * Safe file walking for the verify runtime. Prefers `jj files` when
 * available (fastest, ignores what jj ignores) then falls back to
 * `git ls-files` and finally to a filesystem walk.
 */
import { spawnSync, repoRoot } from "./runtime.ts";
import { resolve, extname } from "node:path";

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
  const roots = CANDIDATE_DIRS.map((d) => resolve(root, d)).filter((p) => {
    try {
      return Bun.file(p).size >= 0 || Bun.file(p).name !== "";
    } catch {
      return false;
    }
  });
  if (roots.length === 0) return { fmtInputs: [], zigFiles: [] };

  // Try jj first
  const jj = spawnSync(
    ["jj", "files", "--", ...CANDIDATE_DIRS.filter((d) => existsRelaxed(resolve(root, d)))],
    { cwd: root },
  );
  let tracked: string[] = [];
  if (jj.code === 0 && jj.stdout.trim().length > 0) {
    tracked = jj.stdout.split("\n").filter((l) => l.length > 0);
  } else {
    const git = spawnSync(
      ["git", "ls-files", ...CANDIDATE_DIRS.filter((d) => existsRelaxed(resolve(root, d)))],
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
  try {
    const f = Bun.file(path);
    return f.size >= 0;
  } catch {
    return false;
  }
}

function fsWalk(root: string): { fmtInputs: string[]; zigFiles: string[] } {
  const { statSync } = require("node:fs") as typeof import("node:fs");
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
