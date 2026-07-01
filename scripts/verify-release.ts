#!/usr/bin/env bun
/**
 * verify-release.ts — Tier 4 (hours).
 *
 * Pre-tag gate. Runs verify-pr first, then:
 *   1. Clean non-incremental rebuild
 *   2. Reproducibility check (two clean rebuilds, hash-compare zig-out/bin)
 *   3. Deep fuzz (FUZZ_BUDGET_SECONDS, default 7200 = 2h), only when
 *      `fuzz` step exists and the platform supports it. Budget-elapsed is
 *      treated as a pass ("fuzz budget elapsed; no crashes").
 *   4. SBOM via `zig run scripts/emit-sbom.zig`, falling back to `syft` if
 *      on PATH; otherwise a loud skip. The generated SBOM is then VALIDATED
 *      (CycloneDX shape + declared-dependency coverage) and the gate fails on
 *      a malformed/incomplete document (Phase 4).
 *   5. cosign signing — opt-in via COSIGN_ENABLED=1 in CI. When requested,
 *      the signing environment is pre-flight-validated and the gate FAILS
 *      (never silently skips) if it is incomplete (Phase 2); each signed
 *      artifact is then verify-blob'd (Phase 3). Not requested → clean skip
 *      referencing doc/adr/0001 §0.12.
 *
 * Exit codes:
 *   0 — pass
 *   1 — real failure (build mismatch, fuzz crash, reproducibility drift)
 */
import { rm } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { appendJsonl, repoRoot, spawnSync, tail } from "./lib/runtime.ts";
import {
	hasBuildStep,
	runFuzz,
	zig,
	zigFuzzSkipMessage,
	zigSupportsFuzz,
} from "./lib/zig.ts";

const TIER = "release" as const;

async function finish(code: number, startedAt: number): Promise<never> {
	const durationMs = Date.now() - startedAt;
	await appendJsonl(".claude/logs/verify.jsonl", {
		event: "verify",
		tier: TIER,
		code,
		durationMs,
	});
	process.exit(code);
}

async function cleanArtifacts(root: string): Promise<void> {
	await rm(resolve(root, ".zig-cache"), { recursive: true, force: true });
	await rm(resolve(root, "zig-out"), { recursive: true, force: true });
}

/**
 * A stable SOURCE_DATE_EPOCH for the reproducibility rebuilds. Zig honors
 * this env var for deterministic timestamps; without it, time-sensitive
 * build outputs can differ between two clean rebuilds and break the
 * reproducibility hash compare. Resolution order:
 *   1. An explicit `SOURCE_DATE_EPOCH` already in the environment (operator
 *      / CI override) — passed through verbatim so a release pipeline can
 *      pin the value across machines.
 *   2. The HEAD commit's author timestamp (`git log -1 --format=%ct`) — the
 *      canonical, content-addressed choice for a tagged release.
 *   3. A fixed fallback epoch when git is unavailable, so the gate stays
 *      deterministic in a tool-less environment rather than picking "now".
 * Returns the value as a decimal-seconds string (the SOURCE_DATE_EPOCH
 * contract).
 */
export function sourceDateEpoch(root: string): string {
	const fromEnv = process.env.SOURCE_DATE_EPOCH;
	if (fromEnv && /^\d+$/.test(fromEnv.trim())) return fromEnv.trim();
	try {
		const r = spawnSync(["git", "-C", root, "log", "-1", "--format=%ct"]);
		const t = (r.stdout || "").trim();
		if (r.code === 0 && /^\d+$/.test(t)) return t;
	} catch {
		// git absent — fall through to the fixed fallback below.
	}
	// 2026-01-01T00:00:00Z — deterministic, clearly-synthetic fallback.
	return "1767225600";
}

/**
 * Hash a directory tree of release artifacts with framing that prevents
 * artifact-boundary aliasing.
 *
 * Each file contributes the following to the digest:
 *   <relative-path-utf8> \0 <byte-length-decimal-utf8> \0 <raw-bytes>
 *
 * Without this framing, hashing the concatenated bytes of `["a"=abc, "b"=def]`
 * collides with `["ab"=abcdef]` because the byte stream is identical. The
 * length-prefix framing makes the digest unambiguous: distinct artifact sets
 * always produce distinct digests.
 *
 * NOTE: the length-prefixed framing below (`path \0 size \0 bytes`) is
 * load-bearing; do not regress to a naive `hasher.update(bytes)` loop.
 * See tests/unit/hash-zig-out.test.ts for the differential cases.
 *
 * Exported so unit tests can exercise the framing on a synthetic tmpdir
 * without spinning up a real `zig build`.
 */
/** Outcome of {@link validateSbom}. */
export type SbomValidation = {
	ok: boolean;
	errors: string[];
	specVersion: string;
	componentCount: number;
};

/**
 * Validate a CycloneDX SBOM document (Phase 4). This is intentionally a
 * structural check, not a full JSON-Schema validation: it confirms the
 * document is the thing it claims to be and actually covers the project's
 * declared dependencies, which is what makes shipping it meaningful.
 *
 * Checks:
 *   - parses as JSON and is an object;
 *   - `bomFormat` == "CycloneDX" and a non-empty `specVersion`;
 *   - `components`, when present, is an array;
 *   - dependency-bearing projects must list components;
 *   - every name in `declaredDeps` appears as a component `name` (so the SBOM
 *     is not silently missing a declared dependency).
 *
 * Returns all failures at once so the gate can report them together.
 */
export function validateSbom(
	raw: string,
	declaredDeps: string[] = [],
): SbomValidation {
	const errors: string[] = [];
	let doc: unknown;
	try {
		doc = JSON.parse(raw);
	} catch (e) {
		return {
			ok: false,
			errors: [`not valid JSON: ${(e as Error).message}`],
			specVersion: "",
			componentCount: 0,
		};
	}
	if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
		return {
			ok: false,
			errors: ["SBOM root is not a JSON object"],
			specVersion: "",
			componentCount: 0,
		};
	}
	const obj = doc as Record<string, unknown>;
	if (obj.bomFormat !== "CycloneDX") {
		errors.push(
			`bomFormat is ${JSON.stringify(obj.bomFormat)}, expected "CycloneDX"`,
		);
	}
	const specVersion =
		typeof obj.specVersion === "string" ? obj.specVersion : "";
	if (specVersion === "") errors.push("missing/empty specVersion");

	const componentsPresent =
		obj.components !== undefined && obj.components !== null;
	const components = Array.isArray(obj.components)
		? (obj.components as Array<Record<string, unknown>>)
		: null;
	if (componentsPresent && components === null) {
		errors.push("components is not an array");
	}
	if (!componentsPresent && declaredDeps.length > 0) {
		errors.push("components is required when declared dependencies exist");
	}
	const componentNames = new Set(
		(components ?? [])
			.map((c) => (typeof c?.name === "string" ? c.name : null))
			.filter((n): n is string => n !== null),
	);
	if (components !== null) {
		for (const dep of declaredDeps) {
			if (!componentNames.has(dep)) {
				errors.push(
					`declared dependency "${dep}" is not present as an SBOM component`,
				);
			}
		}
	}

	return {
		ok: errors.length === 0,
		errors,
		specVersion,
		componentCount: components?.length ?? 0,
	};
}

/**
 * Names of the dependencies declared in `build.zig.zon`'s `.dependencies`
 * block, used to cross-check SBOM completeness. Best-effort: parses the
 * `.dependencies = .{ .name = .{ ... } }` keys with a tolerant regex (the zon
 * grammar has no JSON parser here). Returns [] when the file or block is
 * absent — an SBOM for a dependency-free project then needs no coverage check.
 */
export async function declaredDepNames(root: string): Promise<string[]> {
	const zonPath = resolve(root, "build.zig.zon");
	const file = Bun.file(zonPath);
	if (!(await file.exists())) return [];
	const text = await file.text();
	const depsMatch = text.match(/\.dependencies\s*=\s*\.\{/);
	if (!depsMatch) return [];
	// Walk the `.dependencies` block char-by-char tracking brace depth, and
	// record a `.name = .{` key ONLY when it sits at the block's TOP level
	// (depth 1 — i.e. a direct child of `.dependencies`). A flat regex over the
	// whole block is depth-blind: it would also capture nested keys such as a
	// dependency's own `.foo = .{ ... }` fields, injecting non-dependency names
	// into the SBOM coverage check and false-failing the gate (CodeRabbit).
	const start = depsMatch.index ?? 0;
	const blockStart = text.indexOf("{", start);
	// Sticky matcher for `.name = .{` (bare or quoted `.@"name"`), tried only
	// at a candidate `.` that begins at the current scan position.
	const keyRe = /\.(?:@"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\s*=\s*\.\{/y;
	const names = new Set<string>();
	let depth = 0;
	for (let i = blockStart; i < text.length; i++) {
		const ch = text[i];
		if (ch === "}") {
			depth--;
			if (depth === 0) break; // end of the .dependencies block
			continue;
		}
		// Only attempt key capture at the block's top level (just inside the
		// outer brace). A match advances `depth` via the `.{` it consumed.
		if (depth === 1 && ch === ".") {
			keyRe.lastIndex = i;
			const m = keyRe.exec(text);
			if (m) {
				names.add(m[1] ?? m[2]);
				// The match consumed the dependency's opening `.{`; account for that
				// nested level and resume scanning right after it.
				depth++;
				i = keyRe.lastIndex - 1; // loop's i++ resumes past the consumed `{`
				continue;
			}
		}
		if (ch === "{") depth++;
	}
	return [...names].sort();
}

/**
 * Phase 2: pre-flight validation of the signing environment, run only when
 * signing is requested (COSIGN_ENABLED=1 in CI). Returns an actionable error
 * string when the environment cannot actually sign, or null when it is usable.
 * Accepts the resolved tool path (null when the binary is absent) so it stays
 * pure/testable; credentials are read from the environment.
 *
 * Two valid modes:
 *   - key-based:  COSIGN_KEY (a key ref / file / KMS URI) is set.
 *   - keyless:    Sigstore OIDC — COSIGN_EXPERIMENTAL=1 (cosign <2) or an
 *                 ambient CI OIDC token (COSIGN_OIDC_* / ACTIONS_ID_TOKEN_*).
 * If neither is configured, signing would fail at runtime — so fail the gate
 * now with guidance instead.
 */
export function signingEnvError(
	toolPath: string | null,
	env: Record<string, string | undefined> = process.env,
): string | null {
	if (toolPath === null) {
		return "cosign binary not found on PATH (COSIGN_ENABLED=1 but cosign is not installed).";
	}
	const hasKey = !!env.COSIGN_KEY && env.COSIGN_KEY.length > 0;
	const hasKeyless =
		env.COSIGN_EXPERIMENTAL === "1" ||
		(!!env.COSIGN_OIDC_ISSUER && env.COSIGN_OIDC_ISSUER.length > 0) ||
		(!!env.ACTIONS_ID_TOKEN_REQUEST_URL &&
			env.ACTIONS_ID_TOKEN_REQUEST_URL.length > 0);
	if (!hasKey && !hasKeyless) {
		return (
			"no signing credentials: set COSIGN_KEY for key-based signing, or enable " +
			"keyless OIDC (COSIGN_EXPERIMENTAL=1 / a CI OIDC token). See doc/adr/0001 §0.12."
		);
	}
	return null;
}

/**
 * Phase 3: build cosign argv for signing and verifying a blob. Key-based
 * signing must pass the configured private key. Keyless verification uses the
 * Sigstore bundle emitted by sign-blob plus the expected certificate identity
 * and OIDC issuer.
 */
export function signingSignArgs(
	artifact: string,
	sigPath: string,
	env: Record<string, string | undefined> = process.env,
	bundlePath = `${artifact}.sigstore.json`,
): string[] {
	const key = env.COSIGN_KEY;
	if (key && key.length > 0) {
		return [
			"sign-blob",
			"--key",
			key,
			"--yes",
			"--output-signature",
			sigPath,
			artifact,
		];
	}
	return ["sign-blob", "--yes", "--bundle", bundlePath, artifact];
}

export function signingVerifyArgs(
	artifact: string,
	sigPath: string,
	env: Record<string, string | undefined> = process.env,
	bundlePath = `${artifact}.sigstore.json`,
): string[] | null {
	const key = env.COSIGN_KEY;
	if (key && key.length > 0) {
		const pub = env.COSIGN_PUBLIC_KEY || key;
		return ["verify-blob", "--key", pub, "--signature", sigPath, artifact];
	}
	const identity = env.COSIGN_CERTIFICATE_IDENTITY;
	const issuer = env.COSIGN_CERTIFICATE_OIDC_ISSUER;
	if (identity && issuer) {
		return [
			"verify-blob",
			"--bundle",
			bundlePath,
			"--certificate-identity",
			identity,
			"--certificate-oidc-issuer",
			issuer,
			artifact,
		];
	}
	return null;
}

// Mach-O constants (64-bit, little-endian — the only shape Zig emits for
// aarch64/x86_64-macos).
const MH_MAGIC_64 = 0xfeedfacf;
const LC_SEGMENT_64 = 0x19;
const LC_UUID = 0x1b;
const REPRO_EXCLUDE_SEGMENTS = new Set(["__LINKEDIT", "__PAGEZERO"]);

/**
 * Normalize one artifact's bytes for the reproducibility hash.
 *
 * macOS is NOT byte-reproducible even with SOURCE_DATE_EPOCH pinned: the
 * system linker stamps a random LC_UUID per link, and the ad-hoc code
 * signature + symbol tables in __LINKEDIT are derived from it — so two clean
 * rebuilds of identical source differ in ~140 bytes. This was confirmed
 * empirically: the ONLY non-deterministic bytes in the *loadable* image are
 * the 16-byte LC_UUID payload (which physically sits in the __TEXT segment's
 * header area); `__text` code and all `__DATA*` are byte-identical across
 * builds. The remaining variance lives entirely in __LINKEDIT (signature +
 * symtab bookkeeping), which is not part of the program image.
 *
 * So for a Mach-O we hash only the loadable segments (excluding __LINKEDIT /
 * __PAGEZERO) with the LC_UUID payload zeroed. The result is a deterministic
 * digest of the actual code+data — a true "the build is reproducible" signal
 * that tolerates the linker's non-deterministic bookkeeping. Non-Mach-O
 * artifacts (ELF, PE, wasm) are returned unchanged: on their native
 * toolchains they are byte-reproducible with SOURCE_DATE_EPOCH, so the strict
 * byte compare stays authoritative there (notably on Linux CI).
 *
 * See ADR 0005 (reproducibility-darwin-uuid) for the full rationale.
 */
export function normalizeForRepro(input: Uint8Array): Uint8Array {
	if (input.byteLength < 32) return input;
	const dv = new DataView(input.buffer, input.byteOffset, input.byteLength);
	if (dv.getUint32(0, true) !== MH_MAGIC_64) return input; // not Mach-O 64
	const ncmds = dv.getUint32(16, true);
	const buf = new Uint8Array(input); // copy; we zero the UUID in place
	const bdv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	// Pass 1: zero the LC_UUID payload (16 bytes after the 8-byte lc header).
	let off = 32; // sizeof(mach_header_64)
	for (let i = 0; i < ncmds && off + 8 <= buf.byteLength; i++) {
		const cmd = bdv.getUint32(off, true);
		const cmdsize = bdv.getUint32(off + 4, true);
		const nextOff = off + cmdsize;
		if (cmdsize < 8 || nextOff > buf.byteLength) break;
		if (cmd === LC_UUID) buf.fill(0, off + 8, Math.min(off + 24, nextOff));
		off = nextOff;
	}
	// Pass 2: concatenate loadable-segment file ranges (framed by segname+size).
	const dec = new TextDecoder();
	const enc = new TextEncoder();
	const parts: Uint8Array[] = [];
	off = 32;
	for (let i = 0; i < ncmds && off + 8 <= buf.byteLength; i++) {
		const cmd = bdv.getUint32(off, true);
		const cmdsize = bdv.getUint32(off + 4, true);
		const nextOff = off + cmdsize;
		if (cmdsize < 8 || nextOff > buf.byteLength) break;
		if (cmd === LC_SEGMENT_64) {
			if (cmdsize < 56 || off + 56 > buf.byteLength) {
				off = nextOff;
				continue;
			}
			const segname = dec
				.decode(buf.subarray(off + 8, off + 24))
				.replace(/\0+$/, "");
			const fileoff = Number(bdv.getBigUint64(off + 40, true));
			const filesize = Number(bdv.getBigUint64(off + 48, true));
			if (
				!REPRO_EXCLUDE_SEGMENTS.has(segname) &&
				filesize > 0 &&
				fileoff + filesize <= buf.byteLength
			) {
				parts.push(enc.encode(`${segname}\0${filesize}\0`));
				parts.push(buf.subarray(fileoff, fileoff + filesize));
			}
		}
		off = nextOff;
	}
	if (parts.length === 0) return buf; // unparseable: fall back to the copy
	const total = parts.reduce((n, p) => n + p.byteLength, 0);
	const out = new Uint8Array(total);
	let pos = 0;
	for (const p of parts) {
		out.set(p, pos);
		pos += p.byteLength;
	}
	return out;
}

export async function hashDir(dir: string): Promise<string> {
	const glob = new Bun.Glob("*");
	const files: string[] = [];
	try {
		for (const f of glob.scanSync({ cwd: dir, absolute: true })) files.push(f);
	} catch (err) {
		// ENOENT = missing dir → degrade gracefully (caller's "no
		// artifacts under zig-out/bin to sign" path). EACCES / IO errors
		// must NOT be silently swallowed — they're real failures and
		// would let a release sign over an incomplete artifact set.
		if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT")
			return "";
		throw err;
	}
	if (files.length === 0) return "";
	files.sort();
	const hasher = new Bun.CryptoHasher("sha256");
	const NUL = new Uint8Array([0]);
	const enc = new TextEncoder();
	for (const f of files) {
		const raw = new Uint8Array(await Bun.file(f).arrayBuffer());
		// Normalize away platform-linker non-determinism (Mach-O LC_UUID +
		// __LINKEDIT) before framing, so the digest reflects the reproducible
		// program image, not the linker's per-link bookkeeping. Non-Mach-O
		// artifacts pass through unchanged. See normalizeForRepro / ADR 0005.
		const bytes = normalizeForRepro(raw);
		// path \0 size \0 bytes  → length-prefixed framing per file.
		// Use path.relative + forward-slash normalisation so the digest is
		// stable across platforms (manual `startsWith("${dir}/")` slicing
		// fails on Windows where Bun.Glob may return forward slashes but
		// `dir` from path.resolve uses backslashes).
		const rel = relative(dir, f).replaceAll("\\", "/");
		hasher.update(enc.encode(rel));
		hasher.update(NUL);
		hasher.update(enc.encode(String(bytes.byteLength)));
		hasher.update(NUL);
		hasher.update(bytes);
	}
	return hasher.digest("hex");
}

async function hashZigOut(root: string): Promise<string> {
	return hashDir(resolve(root, "zig-out", "bin"));
}

// Discover signable artifacts under `bin`. Returns an empty list if the
// directory is missing or the glob crashes; never throws. Mirrors the
// crash-tolerance of `hashDir` so a project without a `zig-out/bin`
// (e.g. cargo-style layout) skips signing cleanly instead of aborting.
//
// Glob semantics (Bun.Glob): the pattern "*" matches TOP-LEVEL entries
// only — files (and directories, but Bun.Glob.scanSync only yields paths
// it can stat as files in this codepath) directly under `bin`. It does
// NOT recurse. That matches the canonical zig layout: `zig build` writes
// executables flat into `zig-out/bin/<exe>`, with no subdirectories. If
// a future build emits nested artifacts (e.g. per-arch subdirs), this
// pattern must change to a recursive globstar pattern and the caller's
// signing loop needs to handle directory entries explicitly.
//
// Covered by tests/unit/sign-glob.test.ts — the "subdir non-recursion"
// case is the regression boundary for this contract (R7-4).
export function listArtifacts(bin: string): string[] {
	// `"*"` = top-level entries only; intentionally non-recursive.
	const glob = new Bun.Glob("*");
	const out: string[] = [];
	try {
		for (const f of glob.scanSync({ cwd: bin, absolute: true })) out.push(f);
	} catch (err) {
		// ENOENT = missing bin/ → cargo-style layout, skip signing cleanly.
		// EACCES / IO must propagate so release signing aborts loudly
		// instead of silently producing an incomplete signed set.
		if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT")
			return [];
		throw err;
	}
	return out;
}

async function runFuzzBounded(
	limit: string,
	budgetSeconds: number,
): Promise<"pass" | "timeout" | number> {
	return runFuzz({ limit, timeoutMs: budgetSeconds * 1000 });
}

/**
 * Compares two artifact hashes from successive clean rebuilds.
 * Returns "empty" only when both hashes are empty, "match" when both are
 * identical, or "mismatch" otherwise. Exported for one-sided rebuild
 * regression tests.
 */
export function compareHashes(
	h1: string,
	h2: string,
): "match" | "mismatch" | "empty" {
	if (h1.length === 0 && h2.length === 0) return "empty";
	if (h1.length === 0 || h2.length === 0) return "mismatch";
	if (h1 === h2) return "match";
	return "mismatch";
}

async function main(): Promise<void> {
	const startedAt = Date.now();
	const root = repoRoot();

	console.log("== verify-release -> verify-pr ==");
	const pr = Bun.spawnSync(["bun", "scripts/verify-pr.ts"], {
		cwd: root,
		stdout: "inherit",
		stderr: "inherit",
		stdin: "ignore",
	});
	if (pr.exitCode !== 0) await finish(pr.exitCode ?? 1, startedAt);

	// Pin one SOURCE_DATE_EPOCH for BOTH rebuilds so timestamps embedded in
	// build outputs are identical — a prerequisite for the hash compare below.
	const sde = sourceDateEpoch(root);
	const buildEnv = { SOURCE_DATE_EPOCH: sde };
	console.log(`== Clean non-incremental rebuild (SOURCE_DATE_EPOCH=${sde}) ==`);
	await cleanArtifacts(root);
	const build1 = zig(["build", "--summary", "all"], buildEnv);
	process.stdout.write(build1.stdout);
	process.stderr.write(build1.stderr);
	if (build1.code !== 0) {
		console.error("verify-release: clean rebuild failed");
		console.error(tail(build1.stderr || build1.stdout));
		await finish(build1.code ?? 1, startedAt);
	}
	const h1 = await hashZigOut(root);

	console.log("== Reproducibility check (second clean rebuild) ==");
	await cleanArtifacts(root);
	const build2 = zig(["build", "--summary", "all"], buildEnv);
	process.stdout.write(build2.stdout);
	process.stderr.write(build2.stderr);
	if (build2.code !== 0) {
		console.error("verify-release: second clean rebuild failed");
		await finish(build2.code ?? 1, startedAt);
	}
	const h2 = await hashZigOut(root);

	if (h1.length === 0 && h2.length === 0) {
		console.log(
			"(no zig-out/bin/* artifacts to hash — reproducibility check skipped)",
		);
	} else if (h1 !== h2) {
		console.error("verify-release: rebuild produced different artifact hash");
		console.error(`  first:  ${h1}`);
		console.error(`  second: ${h2}`);
		await finish(1, startedAt);
	} else {
		console.log(`(reproducible: ${h1})`);
	}

	if (hasBuildStep("fuzz")) {
		if (zigSupportsFuzz()) {
			const limit = process.env.RELEASE_FUZZ_LIMIT ?? "1G";
			const budget = Number(process.env.FUZZ_BUDGET_SECONDS ?? "7200");
			console.log(`== Deep fuzz (${budget}s, --fuzz=${limit}) ==`);
			const verdict = await runFuzzBounded(
				limit,
				Number.isFinite(budget) && budget > 0 ? budget : 7200,
			);
			if (verdict === "timeout") {
				console.log("(fuzz budget elapsed; no crashes)");
			} else if (verdict === "pass") {
				console.log("(fuzz completed within budget)");
			} else {
				// runFuzzBounded never returns 0 here (handled above as "pass").
				console.error(`verify-release: fuzz crashed (exit ${verdict})`);
				await finish(verdict, startedAt);
			}
		} else {
			console.log(zigFuzzSkipMessage());
		}
	} else {
		console.log("(no 'fuzz' build step — skipping fuzz gate)");
	}

	console.log("== SBOM (CycloneDX) ==");
	const sbomPath = resolve(root, "sbom.cdx.json");
	const sbomScript = resolve(root, "scripts/emit-sbom.zig");
	let sbomWritten = false;
	if (await Bun.file(sbomScript).exists()) {
		const sbom = zig(["run", sbomScript, "--", "build.zig.zon"]);
		if (sbom.code === 0) {
			await Bun.write(sbomPath, sbom.stdout);
			console.log("(wrote sbom.cdx.json)");
			sbomWritten = true;
		} else {
			console.error("verify-release: emit-sbom.zig failed");
			console.error(tail(sbom.stderr));
			await finish(sbom.code ?? 1, startedAt);
		}
	} else {
		// `command` is a shell builtin; use Bun.which for binary lookups.
		if (Bun.which("syft") !== null) {
			const syft = spawnSync(["syft", "dir:.", "-o", "cyclonedx-json"]);
			if (syft.code === 0) {
				await Bun.write(sbomPath, syft.stdout);
				console.log("(wrote sbom.cdx.json via syft fallback)");
				sbomWritten = true;
			} else {
				console.error("verify-release: syft fallback failed");
				await finish(syft.code ?? 1, startedAt);
			}
		} else {
			console.log(
				"(no scripts/emit-sbom.zig and no syft on PATH — SBOM emission skipped)",
			);
		}
	}

	// Phase 4: validate the generated SBOM before it ships. A malformed or
	// incomplete CycloneDX document is worse than none — downstream consumers
	// trust it. Check it parses, is CycloneDX, and lists components covering
	// the dependencies declared in build.zig.zon.
	if (sbomWritten) {
		const raw = await Bun.file(sbomPath).text();
		const declaredDeps = await declaredDepNames(root);
		const result = validateSbom(raw, declaredDeps);
		if (!result.ok) {
			console.error("verify-release: SBOM validation failed");
			for (const e of result.errors) console.error(`  - ${e}`);
			await finish(1, startedAt);
		}
		console.log(
			`(SBOM valid: CycloneDX ${result.specVersion}, ${result.componentCount} components` +
				`${declaredDeps.length > 0 ? `, ${declaredDeps.length} declared deps covered` : ""})`,
		);
	}

	console.log("== sign artifacts (cosign) ==");
	// `command` is a shell builtin; use Bun.which for binary lookups.
	const signTool = Bun.which("cosign");
	const signEnabled = process.env.COSIGN_ENABLED === "1";
	const inCI = process.env.CI === "true" || process.env.CI === "1";

	if (!signEnabled || !inCI) {
		// Signing is opt-in (release boundary, §0.12). When NOT requested, skip
		// cleanly — this is the normal local / non-release path.
		console.log(
			"(signing not requested — set COSIGN_ENABLED=1 in CI to sign; see doc/adr/0001 §0.12)",
		);
	} else {
		// Phase 2: signing IS requested. A misconfigured signer must FAIL the
		// gate, never silently skip — otherwise a release that intends to be
		// signed could ship unsigned. Validate the environment up front.
		const envError = signingEnvError(signTool);
		if (envError !== null) {
			console.error(
				"verify-release: signing requested but environment is incomplete",
			);
			console.error(`  ${envError}`);
			await finish(1, startedAt);
		}
		const bin = resolve(root, "zig-out", "bin");
		const artifacts = listArtifacts(bin);
		if (artifacts.length === 0) {
			console.log("(no artifacts under zig-out/bin to sign)");
		} else {
			for (const artifact of artifacts) {
				const sigPath = `${artifact}.sig`;
				const sig = spawnSync([
					"cosign",
					...signingSignArgs(artifact, sigPath),
				]);
				if (sig.code !== 0) {
					console.error(`verify-release: sign-blob failed for ${artifact}`);
					console.error(tail(sig.stderr));
					await finish(sig.code ?? 1, startedAt);
				}
				// Phase 3: verify the signature we just produced. A misconfigured
				// signer can emit an unusable .sig; catch it here, at release time,
				// not at a downstream consumer. Keyless (OIDC) and key-based modes
				// need different verify inputs.
				const verifyArgs = signingVerifyArgs(artifact, sigPath);
				if (verifyArgs === null) {
					console.log(
						`(signed ${artifact}; verify-blob skipped — keyless verify needs ` +
							"COSIGN_CERTIFICATE_IDENTITY + COSIGN_CERTIFICATE_OIDC_ISSUER)",
					);
					continue;
				}
				const verify = spawnSync(["cosign", ...verifyArgs]);
				if (verify.code !== 0) {
					console.error(`verify-release: verify-blob failed for ${artifact}`);
					console.error(tail(verify.stderr));
					await finish(verify.code ?? 1, startedAt);
				}
				console.log(`(signed + verified ${artifact})`);
			}
		}
	}

	console.log("verify-release: OK");
	await finish(0, startedAt);
}

// Only run as a CLI when invoked directly. Importing for unit tests
// (e.g. tests/unit/hash-zig-out.test.ts re-using `hashDir`) must not
// trigger a full release verify pass.
if (import.meta.main) {
	await main();
}
