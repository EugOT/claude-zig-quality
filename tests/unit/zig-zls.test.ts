/**
 * Tests for `zlsLaunchArgv`, `zigExePath`, and `zig()` in scripts/lib/zig.ts.
 *
 * Seam approach — two techniques, chosen per test:
 *
 *   A) In-process env mutation ($ZLS, $ZIG) for cases where the function reads
 *      only those env vars (zlsLaunchArgv tests 1, 2, 4; zigExePath test 5).
 *      `Bun.which("mise")` ignores process.env.PATH mutations at runtime — it
 *      reads PATH at process startup only — so PATH shadowing is ineffective.
 *
 *   B) Child-process spawning with an explicit restricted `env` for cases that
 *      require `Bun.which("mise")` to return null (tests 3, 6). A fresh Bun
 *      process started with PATH=/usr/bin:/bin starts with a PATH that does not
 *      contain mise, so Bun.which("mise") returns null inside that child.
 *
 *   C) Fake $ZIG executable (shell wrapper → `bun run <mjs recorder>`) for
 *      zig() spawn-wrapper tests (7–11). The fake records argv and env to JSON
 *      files; the test asserts on those files.
 *
 * env is saved/restored in beforeEach/afterEach so no test bleeds into another.
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
	zlsLaunchArgv,
	zigExePath,
	zig,
} from "../../scripts/lib/zig.ts";

// ---------------------------------------------------------------------------
// Saved env values — fully restored after every test
// ---------------------------------------------------------------------------
let savedZls: string | undefined;
let savedZig: string | undefined;
let savedMiseTrusted: string | undefined;

let tmpDir: string | null = null;

// Absolute path to scripts/lib/zig.ts for subprocess imports
const ZIG_MODULE = resolve(import.meta.dir, "../../scripts/lib/zig.ts");
const BUN_EXE = process.execPath;

beforeEach(() => {
	savedZls = process.env.ZLS;
	savedZig = process.env.ZIG;
	savedMiseTrusted = process.env.MISE_TRUSTED_CONFIG_PATHS;

	delete process.env.ZLS;
	delete process.env.ZIG;
	delete process.env.MISE_TRUSTED_CONFIG_PATHS;
});

afterEach(async () => {
	if (savedZls === undefined) delete process.env.ZLS;
	else process.env.ZLS = savedZls;

	if (savedZig === undefined) delete process.env.ZIG;
	else process.env.ZIG = savedZig;

	if (savedMiseTrusted === undefined) delete process.env.MISE_TRUSTED_CONFIG_PATHS;
	else process.env.MISE_TRUSTED_CONFIG_PATHS = savedMiseTrusted;

	if (tmpDir) {
		await rm(tmpDir, { recursive: true, force: true });
		tmpDir = null;
	}
});

// ---------------------------------------------------------------------------
// Subprocess helper (seam B): run a small inline script in a child process
// with a restricted PATH so Bun.which("mise") starts as null.
// Returns { stdout, stderr, exitCode }.
// ---------------------------------------------------------------------------
async function runInRestrictedEnv(
	script: string,
	extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn([BUN_EXE, "-e", script], {
		env: {
			// Minimal safe PATH: no mise, but git/system tools still reachable.
			PATH: "/usr/bin:/bin",
			HOME: process.env.HOME ?? "",
			CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR ?? "",
			...extraEnv,
		},
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	});
	const [out, err] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const exitCode = await proc.exited;
	return { stdout: out, stderr: err, exitCode };
}

// ---------------------------------------------------------------------------
// Fake $ZIG executable (seam C)
// Creates a shell wrapper that calls `bun run <recorder.mjs>`.
// The recorder writes process.argv.slice(2) → FAKE_ZIG_ARGV_FILE (JSON)
// and process.env              → FAKE_ZIG_ENV_FILE (JSON).
// Returns the path to the wrapper script.
// ---------------------------------------------------------------------------
async function createFakeZigExecutable(dir: string): Promise<string> {
	// The recorder: a plain .mjs file (no shebang needed, invoked via bun run)
	const recorderPath = join(dir, "fake-zig-recorder.mjs");
	await writeFile(
		recorderPath,
		[
			'import { writeFileSync } from "node:fs";',
			'const args = process.argv.slice(2);',
			'const argvFile = process.env.FAKE_ZIG_ARGV_FILE;',
			'const envFile  = process.env.FAKE_ZIG_ENV_FILE;',
			'if (argvFile) writeFileSync(argvFile, JSON.stringify(args));',
			'if (envFile)  writeFileSync(envFile,  JSON.stringify({...process.env}));',
			'process.exit(0);',
		].join("\n"),
	);

	// The wrapper: a #!/bin/sh script that exec's bun run <recorder> "$@"
	const wrapperPath = join(dir, "fake-zig");
	await writeFile(
		wrapperPath,
		`#!/bin/sh\nexec ${BUN_EXE} run ${recorderPath} "$@"\n`,
	);
	await chmod(wrapperPath, 0o755);
	return wrapperPath;
}

/**
 * Invoke `zig(zigArgs, extraEnv)` with $ZIG pointing to the fake recorder.
 * Returns the argv and env the child received.
 */
async function spawnWithFakeZig(
	zigArgs: string[],
	extraEnv: Record<string, string> = {},
): Promise<{ argv: string[]; spawnedEnv: Record<string, string> }> {
	const dir = await mkdtemp(join(tmpdir(), "zig-zls-spawn-"));
	tmpDir = dir;

	const argvFile = join(dir, "argv.json");
	const envFile  = join(dir, "env.json");

	const fakeZig = await createFakeZigExecutable(dir);
	process.env.ZIG = fakeZig;

	const result = zig(zigArgs, {
		FAKE_ZIG_ARGV_FILE: argvFile,
		FAKE_ZIG_ENV_FILE:  envFile,
		...extraEnv,
	});
	expect(result.code).toBe(0);

	const argv       = JSON.parse(await Bun.file(argvFile).text()) as string[];
	const spawnedEnv = JSON.parse(await Bun.file(envFile).text())  as Record<string, string>;
	return { argv, spawnedEnv };
}

// ===========================================================================
// zlsLaunchArgv (tests 1–4)
// ===========================================================================

describe("zlsLaunchArgv", () => {
	test("(1) $ZLS set → returns [$ZLS, ...extraArgs]", () => {
		process.env.ZLS = "/pinned/zls-0.16.0";
		const result = zlsLaunchArgv(["--stdio"]);
		expect(result).toEqual(["/pinned/zls-0.16.0", "--stdio"]);
	});

	test("(2) $ZLS unset + mise present → mise argv with zls@0.16.0", () => {
		// mise IS on this system; ZLS already deleted by beforeEach.
		// Bun.which("mise") will return non-null → mise branch fires.
		const result = zlsLaunchArgv();
		expect(result).toEqual(["mise", "x", "zls@0.16.0", "--", "zls"]);
	});

	test("(3) $ZLS unset + mise absent → null (degradation signal)", async () => {
		// Seam B: subprocess with PATH that contains no mise.
		// Bun.which("mise") in the child starts as null → degradation branch.
		const { stdout, exitCode } = await runInRestrictedEnv(
			`import { zlsLaunchArgv } from "${ZIG_MODULE}"; ` +
			`process.stdout.write(JSON.stringify(zlsLaunchArgv()));`,
		);
		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toBeNull();
	});

	test("(4) extraArgs appended after 'zls' in the mise branch", () => {
		// mise present; ZLS unset → mise branch, extra args forwarded.
		const result = zlsLaunchArgv(["--stdio", "--debug"]);
		expect(result).toEqual([
			"mise", "x", "zls@0.16.0", "--", "zls", "--stdio", "--debug",
		]);
	});
});

// ===========================================================================
// zigExePath (tests 5–6)
// ===========================================================================

describe("zigExePath", () => {
	test("(5) $ZIG set → resolution is 'env', returns $ZIG path", () => {
		process.env.ZIG = "/usr/local/pinned/zig";
		const result = zigExePath();
		expect(result).toBe("/usr/local/pinned/zig");
	});

	test("(6) $ZIG unset + mise absent → resolution is 'bare-path', returns null", async () => {
		// Seam B: subprocess without mise on PATH.
		// zigResolution() → "bare-path" → zigExePath() default branch → null.
		const { stdout, exitCode } = await runInRestrictedEnv(
			`import { zigExePath } from "${ZIG_MODULE}"; ` +
			`process.stdout.write(JSON.stringify(zigExePath()));`,
		);
		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toBeNull();
	});
});

// ===========================================================================
// zig() spawn wrapper (tests 7–11)
// Uses seam C: fake $ZIG shell-wrapper recorder.
// ===========================================================================

describe("zig() spawn wrapper", () => {
	test("(7) 'env' branch invokes $ZIG path, not bare 'zig'", async () => {
		// The fake recorder exits 0 and records args. If zig() used bare 'zig'
		// instead of $ZIG, it would not find our recorder and exit non-zero (or
		// not write the file). Exit 0 + file written proves $ZIG was used.
		const { argv } = await spawnWithFakeZig(["version"]);
		// The recorder receives argv.slice(2) from the shell wrapper invocation:
		// shell wrapper does: bun run recorder.mjs "version"
		// → process.argv in recorder = [bun, recorder.mjs, "version"]
		// → slice(2) = ["version"]
		expect(argv).toContain("version");
	});

	test("(8) 'env' branch merges extraEnv into the child environment", async () => {
		const { spawnedEnv } = await spawnWithFakeZig(["version"], {
			SOURCE_DATE_EPOCH: "1700000000",
		});
		expect(spawnedEnv["SOURCE_DATE_EPOCH"]).toBe("1700000000");
	});

	test("(9) existing MISE_TRUSTED_CONFIG_PATHS forwarded when passed via extraEnv", async () => {
		// In the "env" branch, zig() passes extraEnv as-is (no MISE_TRUSTED injection
		// — that is mise-branch-only). A caller that needs to thread an existing
		// MISE_TRUSTED_CONFIG_PATHS value does so via extraEnv; verify it survives.
		const { spawnedEnv } = await spawnWithFakeZig(["build", "test"], {
			MISE_TRUSTED_CONFIG_PATHS: "/existing/path",
			MY_CUSTOM_VAR: "hello",
		});
		expect(spawnedEnv["MISE_TRUSTED_CONFIG_PATHS"]).toBe("/existing/path");
		expect(spawnedEnv["MY_CUSTOM_VAR"]).toBe("hello");
	});

	test("(10) multiple extraEnv keys all reach the child", async () => {
		const { spawnedEnv } = await spawnWithFakeZig(["fmt", "--check", "src/"], {
			ZIG_QM_KEY_A: "alpha",
			ZIG_QM_KEY_B: "beta",
		});
		expect(spawnedEnv["ZIG_QM_KEY_A"]).toBe("alpha");
		expect(spawnedEnv["ZIG_QM_KEY_B"]).toBe("beta");
	});

	test("(11) $ZIG takes precedence over mise when both are available", async () => {
		// mise is present on this system (Bun.which would return non-null),
		// yet $ZIG is set → zigResolution() returns "env" → $ZIG wins.
		// We verify by confirming the recorder file was created (only possible
		// if our $ZIG fake was actually invoked rather than mise's zig).
		const dir = await mkdtemp(join(tmpdir(), "zig-zls-precedence-"));
		tmpDir = dir;

		const argvFile = join(dir, "argv-precedence.json");
		const fakeZig  = await createFakeZigExecutable(dir);
		process.env.ZIG = fakeZig;

		const result = zig(["version"], { FAKE_ZIG_ARGV_FILE: argvFile });
		expect(result.code).toBe(0);

		// If zig() had used mise instead, the recorder would never run and
		// this file would not exist.
		const exists = await Bun.file(argvFile).exists();
		expect(exists).toBe(true);
	});
});
