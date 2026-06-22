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
import {
	cpuCount,
	repoRoot,
	type SpawnResult,
	spawnSync,
	tail,
} from "./runtime.ts";

const TARGET_VERSION = "0.16.0";

/**
 * How `zig()` will resolve the toolchain for this process:
 *   "env"       — honoring an explicit $ZIG override (pinned by the operator)
 *   "mise"      — `mise x zig@0.16.0` (pinned by .mise.toml; the happy path)
 *   "bare-path" — last-resort bare `zig` on PATH; version is NOT pinned
 *
 * Only "env" and "mise" are deterministic. "bare-path" is host-dependent:
 * §0.7 forbids trusting it silently, so authoritative gates must refuse it.
 */
export type ZigResolution = "env" | "mise" | "bare-path";

export function zigResolution(): ZigResolution {
	const envZig = process.env.ZIG;
	if (envZig && envZig.length > 0) return "env";
	// `command` is a shell builtin and cannot be exec'd by Bun.spawnSync;
	// use Bun.which for binary lookups (CodeRabbit finding).
	if (Bun.which("mise") !== null) return "mise";
	return "bare-path";
}

/** True when the toolchain resolves through a pinned source ($ZIG or mise). */
export function zigIsPinned(): boolean {
	return zigResolution() !== "bare-path";
}

export function zig(
	args: string[],
	extraEnv?: Record<string, string>,
): SpawnResult {
	// `extraEnv` is merged into the child environment across every resolution
	// branch. The per-release tier uses it to thread SOURCE_DATE_EPOCH so two
	// clean rebuilds embed identical timestamps (reproducibility, §release).
	const env =
		extraEnv && Object.keys(extraEnv).length > 0 ? extraEnv : undefined;
	switch (zigResolution()) {
		case "env":
			return spawnSync(
				[process.env.ZIG as string, ...args],
				env ? { env } : {},
			);
		case "mise": {
			const root = repoRoot();
			const trusted = [process.env.MISE_TRUSTED_CONFIG_PATHS, root]
				.filter((s): s is string => !!s && s.length > 0)
				.join(":");
			return spawnSync(
				["mise", "x", `zig@${TARGET_VERSION}`, "--", "zig", ...args],
				{
					env: { MISE_TRUSTED_CONFIG_PATHS: trusted, ...env },
				},
			);
		}
		default:
			console.error(
				"WARN: falling back to bare-PATH zig because neither $ZIG nor mise was available",
			);
			return spawnSync(["zig", ...args], env ? { env } : {});
	}
}

export function zigVersion(): string {
	const r = zig(["version"]);
	return (r.stdout || "").trim();
}

const ZLS_TARGET_VERSION = "0.16.0";

/**
 * The argv that launches ZLS pinned to the target version, mirroring the
 * `zig()` resolution policy:
 *   - $ZLS override wins (operator escape hatch / CI)
 *   - else `mise x zls@0.16.0 -- zls ...` when mise is available (pinned)
 *   - else null — bare-PATH zls is NOT trusted for an authoritative gate
 *     (§0.7), and the caller degrades explicitly instead of guessing.
 *
 * Returning null (rather than a bare `zls`) is deliberate: the ZLS gate is
 * advisory-additive over `zig ast-check`, so "no pinned ZLS" must degrade
 * loudly to the ast-check baseline, never silently run an arbitrary host
 * ZLS whose version may not match the pinned Zig.
 */
export function zlsLaunchArgv(extraArgs: string[] = []): string[] | null {
	const envZls = process.env.ZLS;
	if (envZls && envZls.length > 0) return [envZls, ...extraArgs];
	if (Bun.which("mise") !== null) {
		return [
			"mise",
			"x",
			`zls@${ZLS_TARGET_VERSION}`,
			"--",
			"zls",
			...extraArgs,
		];
	}
	return null;
}

/** True when a pinned ZLS ($ZLS or mise zls@0.16.0) can be launched. */
export function zlsIsAvailable(): boolean {
	return zlsLaunchArgv() !== null;
}

/**
 * Absolute path to the pinned Zig executable, for handing to ZLS as
 * `zig_exe_path` so its build-on-save tier resolves the SAME toolchain the
 * rest of the gate uses (never a stray host `zig`). Returns null when only
 * the bare-PATH fallback is available — the caller then runs ZLS in the
 * zero-config ast-check tier rather than wiring an unpinned zig.
 */
export function zigExePath(): string | null {
	switch (zigResolution()) {
		case "env":
			return process.env.ZIG as string;
		case "mise": {
			const root = repoRoot();
			const trusted = [process.env.MISE_TRUSTED_CONFIG_PATHS, root]
				.filter((s): s is string => !!s && s.length > 0)
				.join(":");
			const r = spawnSync(
				["mise", "which", "--tool", `zig@${TARGET_VERSION}`, "zig"],
				{ env: { MISE_TRUSTED_CONFIG_PATHS: trusted } },
			);
			const p = (r.stdout || "").trim();
			return r.code === 0 && p.length > 0 ? p : null;
		}
		default:
			return null;
	}
}

export function zlsMessage(): string {
	return (
		"(ZLS semantic gate skipped: no pinned ZLS resolvable via $ZLS or " +
		`\`mise x zls@${ZLS_TARGET_VERSION}\`. Install it (\`mise install zls@` +
		`${ZLS_TARGET_VERSION}\`) for the extra per-file semantic layer; ` +
		"`zig ast-check` (per-turn) and `zig build test` (per-PR) still cover " +
		"syntax, unused/shadow, and full compile errors.)"
	);
}

/**
 * True when `zig build -l` exposes a step named `step`. Used by the gate
 * tiers to treat optional steps (lint, docs, fuzz) as present-or-absent
 * rather than hard requirements — so a downstream adopter that removed the
 * step (e.g. opted out of the ziglint dependency) is not broken by the gate.
 */
export function hasBuildStep(step: string): boolean {
	// `step` names a build step the gate author hard-codes ("lint", "docs",
	// "fuzz"); it is never operator/user input. Reject anything that isn't a
	// plain build-step identifier so the regex below is built from a known-safe
	// literal — closing the ast-grep ReDoS warning (CWE-1333) at the source
	// rather than trusting the escape alone.
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(step)) {
		throw new Error(
			`hasBuildStep: invalid step name ${JSON.stringify(step)}; ` +
				"expected a [A-Za-z0-9_-] identifier.",
		);
	}
	// An authoritative gate must resolve a *pinned* toolchain. If `zig()` would
	// fall back to bare-PATH zig (§0.7: never trusted silently), step detection
	// becomes host-dependent — a missing/incompatible host `zig` could make the
	// lint gate silently vanish or misbehave (CodeRabbit finding). Hard-fail
	// with an actionable message instead. Escape hatch: set $ZIG explicitly.
	if (!zigIsPinned()) {
		throw new Error(
			`hasBuildStep("${step}"): refusing to probe build steps with an ` +
				"unpinned bare-PATH zig (§0.7). Install mise (`mise x zig@" +
				`${TARGET_VERSION}\`) or set $ZIG to a pinned 0.16.0 toolchain.`,
		);
	}
	const listing = zig(["build", "-l"]);
	// A non-zero `zig build -l` is a toolchain/build-graph failure, not a
	// "step absent" signal. Returning false here would silently *skip* a
	// gate (e.g. lint) on a broken build instead of failing — exactly the
	// invisible-gate failure mode this gate exists to prevent (CodeRabbit
	// finding). The callers run after the build graph is otherwise sound,
	// so surface the failure rather than masking it.
	if (listing.code !== 0) {
		throw new Error(
			`hasBuildStep("${step}"): \`zig build -l\` failed (exit ${listing.code ?? "?"}); ` +
				`refusing to silently skip the gate.\n${tail(listing.stderr || listing.stdout)}`,
		);
	}
	const text = `${listing.stdout}\n${listing.stderr}`;
	// `step` is validated above to be a bare identifier, so no regex
	// metacharacters can reach the pattern; the escape is belt-and-suspenders.
	const escaped = step.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`^[\\t ]*${escaped}(?:\\s|$)`, "m");
	return re.test(text);
}

/**
 * Darwin + Zig 0.16.0 fuzz is upstream-broken (ziglang/zig#20986). The
 * green gate on macOS must degrade explicitly, never silently. Set
 * ZIG_QM_FORCE_FUZZ=1 to try anyway.
 */
export type ZigSupportsFuzzDeps = {
	platform?: string;
	version?: string;
	forceFuzz?: string;
};

export function zigSupportsFuzz(deps: ZigSupportsFuzzDeps = {}): boolean {
	if ((deps.forceFuzz ?? process.env.ZIG_QM_FORCE_FUZZ) === "1") return true;
	const os = deps.platform ?? process.platform;
	const v = deps.version ?? zigVersion();
	if (os === "darwin" && v === TARGET_VERSION) return false;
	return true;
}

export function zigFuzzSkipMessage(): string {
	const v = zigVersion() || "unknown";
	return `(native \`zig build fuzz\` skipped on ${process.platform} with Zig ${v}; upstream macOS fuzz support is incomplete in ziglang/zig#20986. Set ZIG_QM_FORCE_FUZZ=1 to attempt anyway.)`;
}

/**
 * Run `zig build fuzz` under a wall-clock budget. Returns:
 *   "pass"    — the fuzz target completed cleanly within the budget
 *   "timeout" — the budget elapsed first; treated as a clean pass by callers
 *   number    — non-zero exit code indicating a real fuzz failure
 *
 * Shared between the per-PR (Tier 3) and per-release (Tier 4) gates so
 * the spawn shape, signal handling, and arg list stay identical.
 */
export async function runFuzz(opts: {
	limit: string;
	timeoutMs: number;
	/**
	 * Test seam: override the spawned argv. When omitted, the production
	 * "bun -e <inline> -- <json args>" form is used so `runFuzz` always
	 * launches the real `zig build fuzz` worker. Tests inject a slow stub
	 * (e.g. `["sleep", "5"]`) so timeout detection can be exercised
	 * deterministically in milliseconds, not multi-second budgets.
	 */
	command?: string[];
}): Promise<"pass" | "timeout" | number> {
	const root = repoRoot();
	const controller = new AbortController();
	// `timedOut` is the source of truth: the timer callback both aborts
	// the child *and* marks our intent. After `proc.exited` resolves we
	// check this flag (plus `signal.aborted` as a belt-and-suspenders
	// guard) so a SIGTERM exit (typically code 143) is correctly mapped
	// to "timeout" instead of bubbling up as a fuzz failure.
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, opts.timeoutMs);
	const cmd = opts.command ?? [
		"bun",
		"-e",
		"import { zig } from './scripts/lib/zig.ts';" +
			"const args = JSON.parse(process.argv[1] ?? '[]');" +
			"const r = zig(args);" +
			"process.stdout.write(r.stdout);" +
			"process.stderr.write(r.stderr);" +
			"process.exit(r.code ?? 1);",
		JSON.stringify([
			"build",
			"fuzz",
			"--summary",
			"failures",
			`--fuzz=${opts.limit}`,
			`-j${cpuCount()}`,
		]),
	];
	try {
		const proc = Bun.spawn(cmd, {
			cwd: root,
			stdout: "inherit",
			stderr: "inherit",
			stdin: "ignore",
			signal: controller.signal,
		});
		try {
			const code = await proc.exited;
			if (timedOut || controller.signal.aborted) return "timeout";
			if (code === 0) return "pass";
			return code;
		} catch {
			// Older Bun builds reject `proc.exited` when the abort fires.
			// Either branch funnels into the same "timeout" verdict so the
			// caller's contract holds across runtime versions.
			if (timedOut || controller.signal.aborted) return "timeout";
			throw new Error("runFuzz: child process rejected without timeout");
		}
	} finally {
		// Guarantee timer cleanup so a late-resolving `proc.exited` cannot
		// leave a dangling AbortController callback in the event loop.
		clearTimeout(timer);
	}
}
