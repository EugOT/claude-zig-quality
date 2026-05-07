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
 *      on PATH; otherwise a loud skip message pointing at the ADR.
 *   5. cosign signing — only when cosign is present AND COSIGN_ENABLED=1
 *      AND a CI environment is detected (CI=true). Otherwise logs a skip
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

function hasBuildStep(step: string): boolean {
	const listing = zig(["build", "-l"]);
	const text = `${listing.stdout}\n${listing.stderr}`;
	const escaped = step.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`^[\\t ]*${escaped}(?:\\s|$)`, "m");
	return re.test(text);
}

async function cleanArtifacts(root: string): Promise<void> {
	await rm(resolve(root, ".zig-cache"), { recursive: true, force: true });
	await rm(resolve(root, "zig-out"), { recursive: true, force: true });
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
 * NOTE (Codex R7 P2 follow-up — STALE): the prior commit already added the
 * length-prefixed framing below (`path \0 size \0 bytes`). Re-asserting it
 * here so future drive-by edits do not regress to a naive `hasher.update(bytes)`
 * loop. See tests/unit/hash-zig-out.test.ts for the differential cases.
 *
 * Exported so unit tests can exercise the framing on a synthetic tmpdir
 * without spinning up a real `zig build`.
 */
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
		const bytes = new Uint8Array(await Bun.file(f).arrayBuffer());
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

	console.log("== Clean non-incremental rebuild ==");
	await cleanArtifacts(root);
	const build1 = zig(["build", "--summary", "all"]);
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
	const build2 = zig(["build", "--summary", "all"]);
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
	const sbomScript = resolve(root, "scripts/emit-sbom.zig");
	if (await Bun.file(sbomScript).exists()) {
		const sbom = zig(["run", "scripts/emit-sbom.zig", "--", "build.zig.zon"]);
		if (sbom.code === 0) {
			await Bun.write(resolve(root, "sbom.cdx.json"), sbom.stdout);
			console.log("(wrote sbom.cdx.json)");
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
				await Bun.write(resolve(root, "sbom.cdx.json"), syft.stdout);
				console.log("(wrote sbom.cdx.json via syft fallback)");
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

	console.log("== cosign sign artifacts ==");
	// `command` is a shell builtin; use Bun.which for binary lookups.
	const hasCosign = Bun.which("cosign") !== null;
	const cosignEnabled = process.env.COSIGN_ENABLED === "1";
	const inCI = process.env.CI === "true" || process.env.CI === "1";
	if (hasCosign && cosignEnabled && inCI) {
		const bin = resolve(root, "zig-out", "bin");
		const artifacts = listArtifacts(bin);
		if (artifacts.length === 0) {
			console.log(
				"(no artifacts under zig-out/bin to sign; skipping cosign step)",
			);
		} else {
			for (const artifact of artifacts) {
				// `--output-signature` lets cosign write the .sig file directly so
				// we do not have to capture its stdout (which mixes status output
				// with the signature blob).
				const sig = spawnSync([
					"cosign",
					"sign-blob",
					"--yes",
					"--output-signature",
					`${artifact}.sig`,
					artifact,
				]);
				if (sig.code !== 0) {
					console.error(
						`verify-release: cosign sign-blob failed for ${artifact}`,
					);
					await finish(sig.code ?? 1, startedAt);
				}
				console.log(`(signed ${artifact})`);
			}
		}
	} else {
		console.log(
			"(cosign not configured; release signing skipped — see doc/adr/0001 + §0.12 release boundary)",
		);
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
