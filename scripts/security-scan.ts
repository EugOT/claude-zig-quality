#!/usr/bin/env bun
import { repoRoot, spawnSync } from "./lib/runtime.ts";
const SECURITY_CHECK_TIMEOUT_MS = 120_000;

export type SecurityCheck = {
	name: string;
	command: string[];
	required: boolean;
};

export type SecurityResult = SecurityCheck & {
	status: "passed" | "failed" | "skipped";
	code: number | null;
};

function toolExists(tool: string): boolean {
	return Bun.which(tool) !== null;
}

export function defaultSecurityChecks(): SecurityCheck[] {
	// `toolExists` filters the default suite for this host. `runSecurityChecks`
	// repeats the lookup for caller-supplied checks, so required custom checks
	// still fail closed when their tool is absent.
	const checks: SecurityCheck[] = [
		{
			name: "git-diff-check",
			command: ["git", "diff", "--check"],
			required: true,
		},
	];
	if (toolExists("bun")) {
		checks.push({
			name: "bun-audit",
			command: ["bun", "audit"],
			required: true,
		});
	}
	if (toolExists("zizmor")) {
		checks.push({
			name: "workflow-security",
			command: ["zizmor", ".forgejo/workflows"],
			required: false,
		});
	}
	if (toolExists("gitleaks")) {
		checks.push({
			name: "secret-scan",
			command: [
				"gitleaks",
				"detect",
				"--no-banner",
				"--redact",
				"--log-opts",
				process.env.SECURITY_SCAN_GITLEAKS_LOG_OPTS ?? "--max-count=200",
			],
			required: false,
		});
	}
	return checks;
}

export function summarizeSecurity(results: SecurityResult[]): {
	ok: boolean;
	failedRequired: string[];
} {
	const failedRequired = results
		.filter((r) => r.required && r.status !== "passed")
		.map((r) => r.name);
	return { ok: failedRequired.length === 0, failedRequired };
}

export function runSecurityChecks(
	checks: SecurityCheck[] = defaultSecurityChecks(),
	cwd = repoRoot(),
): SecurityResult[] {
	const results: SecurityResult[] = [];
	for (const check of checks) {
		const tool = check.command[0];
		if (!tool || Bun.which(tool) === null) {
			results.push({ ...check, status: "skipped", code: null });
			continue;
		}
		const result = spawnSync(check.command, { cwd, timeout: SECURITY_CHECK_TIMEOUT_MS });
		process.stdout.write(result.stdout);
		process.stderr.write(result.stderr);
		results.push({
			...check,
			status: result.code === 0 ? "passed" : "failed",
			code: result.code,
		});
	}
	return results;
}

export async function main(): Promise<void> {
	const results = runSecurityChecks();
	const summary = summarizeSecurity(results);
	console.log(
		JSON.stringify({
			event: "security-scan",
			ok: summary.ok,
			failedRequired: summary.failedRequired,
			results,
		}),
	);
	process.exit(summary.ok ? 0 : 1);
}

if (import.meta.main) await main();
