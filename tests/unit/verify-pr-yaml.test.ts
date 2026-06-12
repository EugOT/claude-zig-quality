/**
 * Test 2.5 — `verify-pr.yaml` lockfile error message is honest.
 *
 * Pre-fix: the workflow hard-coded "bun.lock is out of sync" as the
 * error reason. Network failures, registry outages, sandbox denials,
 * and disk-full all hit the same code path and produced the same
 * misleading "out of sync, run bun install locally" message.
 *
 * Post-fix: the workflow captures the real exit code and emits a
 * generic, exit-code-tagged message. This test is a structural
 * assertion: the literal phrase "out of sync" must not appear, and
 * the new generic message must.
 */

import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { repoRoot } from "../../scripts/lib/runtime.ts";

const yamlPath = resolve(repoRoot(), ".forgejo/workflows/verify-pr.yaml");

test("verify-pr.yaml does not falsely claim 'out of sync' on bun-install failure", async () => {
	const text = await readFile(yamlPath, "utf8");
	expect(text).not.toMatch(/out of sync/i);
});

test("verify-pr.yaml emits a generic, exit-code-tagged install error", async () => {
	const text = await readFile(yamlPath, "utf8");
	// The new message must reference the exit code so the user can
	// distinguish lockfile drift (1) from network/registry failures.
	expect(text).toMatch(
		/bun install --frozen-lockfile failed \(exit \$\{exit_code\}\)/,
	);
});
