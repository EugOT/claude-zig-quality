/**
 * Unit tests for scripts/eval.ts — validateExpectJson() and checkStructure().
 *
 * Both exports are pure async functions that accept explicit arguments, so all
 * tests call them directly (no subprocess). A small `buildValidSkeleton` helper
 * scaffolds a complete valid fixture tree in a tmpdir; each test mutates exactly
 * one thing to trigger the failure under test.
 *
 * Coverage scope:
 *   validateExpectJson — well-formed JSON → null; malformed JSON → CheckFailure
 *   checkStructure     — missing judge-prompt.md; missing domains/; orphan .zig;
 *                        orphan .expect.json; missing threshold key; invalid
 *                        thresholds.json; zero trajectories; non-directory entry
 *                        under domains/ ignored
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkStructure,
	type CheckFailure,
	validateExpectJson,
} from "../../scripts/eval.ts";

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

/**
 * Creates a fully valid eval fixture skeleton under a fresh tmpdir and returns
 * the root path. The skeleton mirrors the real tests/evals/ layout that
 * checkStructure(root) expects:
 *
 *   <root>/tests/evals/
 *     judge-prompt.md
 *     thresholds.json               { "alpha": { "min_pass_rate": 0.9 } }
 *     trajectories/run-001.jsonl
 *     domains/
 *       alpha/
 *         01-case.zig
 *         01-case.expect.json       { "verdict": "pass" }
 */
async function buildValidSkeleton(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "eval-unit-"));
	const evalsDir = join(root, "tests", "evals");
	const domainsDir = join(evalsDir, "domains");
	const alphaDir = join(domainsDir, "alpha");
	const trajDir = join(evalsDir, "trajectories");

	await mkdir(alphaDir, { recursive: true });
	await mkdir(trajDir, { recursive: true });

	await writeFile(join(evalsDir, "judge-prompt.md"), "# Judge prompt\n", "utf8");
	await writeFile(
		join(evalsDir, "thresholds.json"),
		JSON.stringify({ alpha: { min_pass_rate: 0.9 } }),
		"utf8",
	);
	await writeFile(join(trajDir, "run-001.jsonl"), '{"id":1}\n', "utf8");
	await writeFile(join(alphaDir, "01-case.zig"), "// zig source\n", "utf8");
	await writeFile(
		join(alphaDir, "01-case.expect.json"),
		JSON.stringify({ verdict: "pass" }),
		"utf8",
	);

	return root;
}

async function cleanup(root: string): Promise<void> {
	await rm(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// validateExpectJson
// ---------------------------------------------------------------------------

describe("validateExpectJson", () => {
	test("(1) returns null for a well-formed JSON file", async () => {
		const root = await mkdtemp(join(tmpdir(), "eval-vej-"));
		try {
			const filePath = join(root, "ok.expect.json");
			await writeFile(filePath, JSON.stringify({ verdict: "pass", score: 1 }), "utf8");

			const result = await validateExpectJson(filePath);

			expect(result).toBeNull();
		} finally {
			await cleanup(root);
		}
	});

	test("(2) returns CheckFailure with reason matching /invalid JSON/ for malformed file", async () => {
		const root = await mkdtemp(join(tmpdir(), "eval-vej-"));
		try {
			const filePath = join(root, "bad.expect.json");
			await writeFile(filePath, "{ not valid json !!!", "utf8");

			const result = await validateExpectJson(filePath);

			expect(result).not.toBeNull();
			const failure = result as CheckFailure;
			expect(failure.file).toBe(filePath);
			expect(failure.reason).toMatch(/invalid JSON/i);
		} finally {
			await cleanup(root);
		}
	});
});

// ---------------------------------------------------------------------------
// checkStructure — direct calls against tmpdir skeletons
// ---------------------------------------------------------------------------

describe("checkStructure", () => {
	test("(3) missing judge-prompt.md → failure mentioning it", async () => {
		const root = await buildValidSkeleton();
		try {
			const evalsDir = join(root, "tests", "evals");
			await rm(join(evalsDir, "judge-prompt.md"), { force: true });

			const failures = await checkStructure(root);

			const match = failures.find(
				(f) => f.file.includes("judge-prompt.md") || f.reason.includes("judge-prompt.md"),
			);
			expect(match).toBeDefined();
		} finally {
			await cleanup(root);
		}
	});

	test("(4) missing domains/ → returns a failure (no throw), not an exception", async () => {
		const root = await buildValidSkeleton();
		try {
			const domainsDir = join(root, "tests", "evals", "domains");
			await rm(domainsDir, { recursive: true, force: true });

			// Must not throw; must return an array with at least one failure
			let failures!: CheckFailure[];
			await expect(
				(async () => {
					failures = await checkStructure(root);
				})(),
			).resolves.toBeUndefined();

			expect(Array.isArray(failures)).toBe(true);
			expect(failures.length).toBeGreaterThan(0);
			const match = failures.find(
				(f) =>
					f.file.includes("domains") || f.reason.includes("domains"),
			);
			expect(match).toBeDefined();
		} finally {
			await cleanup(root);
		}
	});

	test("(5) orphan .zig without matching .expect.json → 'missing pair' failure", async () => {
		const root = await buildValidSkeleton();
		try {
			const alphaDir = join(root, "tests", "evals", "domains", "alpha");
			// Add an extra .zig with no corresponding .expect.json
			await writeFile(join(alphaDir, "02-orphan.zig"), "// orphan\n", "utf8");

			const failures = await checkStructure(root);

			const match = failures.find(
				(f) =>
					f.file.includes("02-orphan.zig") &&
					f.reason.includes("missing pair"),
			);
			expect(match).toBeDefined();
		} finally {
			await cleanup(root);
		}
	});

	test("(6) orphan .expect.json without matching .zig → 'missing pair' failure", async () => {
		const root = await buildValidSkeleton();
		try {
			const alphaDir = join(root, "tests", "evals", "domains", "alpha");
			// Add an extra .expect.json with no corresponding .zig
			await writeFile(
				join(alphaDir, "03-orphan.expect.json"),
				JSON.stringify({ verdict: "pass" }),
				"utf8",
			);

			const failures = await checkStructure(root);

			const match = failures.find(
				(f) =>
					f.file.includes("03-orphan.expect.json") &&
					f.reason.includes("missing pair"),
			);
			expect(match).toBeDefined();
		} finally {
			await cleanup(root);
		}
	});

	test("(7) thresholds.json missing a key for an existing domain → failure", async () => {
		const root = await buildValidSkeleton();
		try {
			const evalsDir = join(root, "tests", "evals");
			const domainsDir = join(evalsDir, "domains");

			// Add a second domain 'beta' but do not add its key to thresholds.json
			const betaDir = join(domainsDir, "beta");
			await mkdir(betaDir, { recursive: true });
			await writeFile(join(betaDir, "01-case.zig"), "// zig\n", "utf8");
			await writeFile(
				join(betaDir, "01-case.expect.json"),
				JSON.stringify({ verdict: "pass" }),
				"utf8",
			);
			// thresholds.json only has 'alpha', not 'beta'

			const failures = await checkStructure(root);

			const match = failures.find(
				(f) =>
					f.file.includes("thresholds.json") &&
					f.reason.includes("beta"),
			);
			expect(match).toBeDefined();
		} finally {
			await cleanup(root);
		}
	});

	test("(8) thresholds.json with invalid JSON → failure", async () => {
		const root = await buildValidSkeleton();
		try {
			const evalsDir = join(root, "tests", "evals");
			await writeFile(
				join(evalsDir, "thresholds.json"),
				"{ broken json !!!",
				"utf8",
			);

			const failures = await checkStructure(root);

			const match = failures.find(
				(f) =>
					f.file.includes("thresholds.json") &&
					f.reason.includes("invalid JSON"),
			);
			expect(match).toBeDefined();
		} finally {
			await cleanup(root);
		}
	});

	test("(9) zero .jsonl trajectories → failure", async () => {
		const root = await buildValidSkeleton();
		try {
			const trajDir = join(root, "tests", "evals", "trajectories");
			// Remove the only .jsonl file
			await rm(join(trajDir, "run-001.jsonl"), { force: true });

			const failures = await checkStructure(root);

			const match = failures.find(
				(f) =>
					f.file.includes("trajectories") &&
					f.reason.includes("no *.jsonl"),
			);
			expect(match).toBeDefined();
		} finally {
			await cleanup(root);
		}
	});

	test("(10) a non-directory file under domains/ is ignored and causes no failure", async () => {
		const root = await buildValidSkeleton();
		try {
			const domainsDir = join(root, "tests", "evals", "domains");
			// Place a plain file directly under domains/ — it must be silently
			// ignored (not treated as a domain directory)
			await writeFile(join(domainsDir, "stray-file.txt"), "noise\n", "utf8");

			const failures = await checkStructure(root);

			// The stray file must not produce any failure on its own
			const strayFailure = failures.find((f) =>
				f.file.includes("stray-file.txt") || f.reason.includes("stray-file.txt"),
			);
			expect(strayFailure).toBeUndefined();

			// The valid skeleton still passes all other checks
			expect(failures).toHaveLength(0);
		} finally {
			await cleanup(root);
		}
	});
});
