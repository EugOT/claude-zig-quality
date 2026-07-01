import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { repoRoot } from "../../scripts/lib/runtime.ts";

const workflowPath = resolve(
	repoRoot(),
	".forgejo/workflows/coverage-security.yaml",
);
const templatePath = resolve(
	repoRoot(),
	"templates/forgejo/coverage-security.yaml",
);

async function readWorkflowCopies(): Promise<string[]> {
	return Promise.all([
		readFile(workflowPath, "utf8"),
		readFile(templatePath, "utf8"),
	]);
}

test("coverage-security workflow runs the repo-owned gates", async () => {
	for (const text of await readWorkflowCopies()) {
		expect(text).toContain("bun scripts/verify-pr.ts");
		expect(text).toContain("bun scripts/security-scan.ts");
		expect(text).toContain("bun scripts/coverage-docker.ts");
		expect(text).toMatch(/if: \$\{\{ always\(\) \}\}/);
	}
});

test("coverage-security workflow enforces measured Docker coverage", async () => {
	for (const text of await readWorkflowCopies()) {
		expect(text).toContain(
			"bun scripts/coverage-docker.ts --fail-under-lines 95",
		);
		expect(text).not.toContain("--skip-missing-kcov");
	}
});

test("coverage-security workflow keeps install errors honest", async () => {
	for (const text of await readWorkflowCopies()) {
		expect(text).toMatch(
			/bun install --frozen-lockfile failed \(exit \$\{exit_code\}\)/,
		);
		expect(text).not.toMatch(/out of sync/i);
	}
});

test("coverage-security template mirrors live workflow", async () => {
	const [live, template] = await readWorkflowCopies();
	const normalize = (text: string) => text.replace(/\r\n/g, "\n");
	expect(normalize(template)).toBe(normalize(live));
});
