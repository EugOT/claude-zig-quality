/**
 * Repo-owned Zig toolchain wrapper. Semantics match the validated
 * `scripts/zig-tool.sh` in gitstore-cli:
 *
 *   1. If ZIG env var is set, honor it (escape hatch for CI/local overrides)
 *   2. Otherwise, if `mise` is available, resolve through
 *      `mise x zig@0.16.0 -- zig` with the repo root in
 *      MISE_TRUSTED_CONFIG_PATHS so the local .mise.toml is trusted
 *   3. Otherwise, fall through to bare `zig` on PATH (last resort)
 *
 * Never trust bare PATH `zig` silently: §0.7 non-negotiable.
 */
import { spawnSync, type SpawnResult, repoRoot } from "./runtime.ts";

const TARGET_VERSION = "0.16.0";

export function zig(args: string[]): SpawnResult {
  const envZig = process.env.ZIG;
  if (envZig && envZig.length > 0) {
    return spawnSync([envZig, ...args]);
  }
  const hasMise = spawnSync(["command", "-v", "mise"]);
  if (hasMise.code === 0) {
    const root = repoRoot();
    const trusted = [process.env.MISE_TRUSTED_CONFIG_PATHS, root]
      .filter((s): s is string => !!s && s.length > 0)
      .join(":");
    return spawnSync(["mise", "x", `zig@${TARGET_VERSION}`, "--", "zig", ...args], {
      env: { MISE_TRUSTED_CONFIG_PATHS: trusted },
    });
  }
  return spawnSync(["zig", ...args]);
}

export function zigVersion(): string {
  const r = zig(["version"]);
  return (r.stdout || "").trim();
}

/**
 * Darwin + Zig 0.16.0 fuzz is upstream-broken (ziglang/zig#20986). The
 * green gate on macOS must degrade explicitly, never silently. Set
 * ZIG_QM_FORCE_FUZZ=1 to try anyway.
 */
export function zigSupportsFuzz(): boolean {
  if (process.env.ZIG_QM_FORCE_FUZZ === "1") return true;
  const os = process.platform;
  const v = zigVersion();
  if (os === "darwin" && v === TARGET_VERSION) return false;
  return true;
}

export function zigFuzzSkipMessage(): string {
  const v = zigVersion() || "unknown";
  return `(native \`zig build fuzz\` skipped on ${process.platform} with Zig ${v}; upstream macOS fuzz support is incomplete in ziglang/zig#20986. Set ZIG_QM_FORCE_FUZZ=1 to attempt anyway.)`;
}
