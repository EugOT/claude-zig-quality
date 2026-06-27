import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { repoRoot } from "../../scripts/lib/runtime.ts";

const workflowPath = resolve(
	repoRoot(),
	".forgejo/workflows/coverage-security.yaml",
);

test("coverage-security workflow runs the repo-owned gates", async () => {
	const text = await readFile(workflowPath, "utf8");
	expect(text).toContain("bun scripts/verify-pr.ts");
	expect(text).toContain("bun scripts/security-scan.ts");
	expect(text).toContain("bun scripts/coverage-docker.ts");
});

test("coverage-security workflow enforces measured Docker coverage", async () => {
	const text = await readFile(workflowPath, "utf8");
	expect(text).toContain(
		"bun scripts/coverage-docker.ts --fail-under-lines 95",
	);
	expect(text).not.toContain("--skip-missing-kcov");
});

test("coverage-security workflow keeps install errors honest", async () => {
	const text = await readFile(workflowPath, "utf8");
	expect(text).toMatch(
		/bun install --frozen-lockfile failed \(exit \$\{exit_code\}\)/,
	);
	expect(text).not.toMatch(/out of sync/i);
});
