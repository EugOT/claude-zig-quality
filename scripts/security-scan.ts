#!/usr/bin/env bun
import { repoRoot, spawnSync } from "./lib/runtime.ts";

const SECURITY_CHECK_TIMEOUT_MS = 120_000;

export type SecurityCheck = {
	name: string;
	command: string[];
	required: boolean;
};

export type SecurityResult = SecurityCheck & {
	status: "passed" | "failed" | "skipped" | "timed-out";
	code: number | null;
};

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export function gitDiffCheckCommand(
	env: Record<string, string | undefined> = process.env,
): string[] {
	const explicitRange = env.SECURITY_SCAN_GIT_DIFF_RANGE;
	if (explicitRange && explicitRange.length > 0) {
		return ["git", "diff", "--check", explicitRange];
	}
	const baseSha = env.GITHUB_BASE_SHA ?? env.CI_MERGE_REQUEST_DIFF_BASE_SHA;
	if (baseSha && baseSha.length > 0) {
		return ["git", "diff", "--check", `${baseSha}...HEAD`];
	}
	const baseRef =
		env.GITHUB_BASE_REF ??
		env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME ??
		env.CI_DEFAULT_BRANCH;
	if (baseRef && baseRef.length > 0) {
		const remoteBase =
			baseRef.startsWith("refs/") || baseRef.startsWith("origin/")
				? baseRef
				: `origin/${baseRef}`;
		const quotedBase = shellQuote(remoteBase);
		return [
			"sh",
			"-c",
			`base=$(git merge-base HEAD ${quotedBase} 2>/dev/null || printf %s ${quotedBase}); git diff --check "$base"...HEAD`,
		];
	}
	return ["git", "diff", "--check"];
}

export function defaultSecurityChecks(): SecurityCheck[] {
	// Required checks stay in the default suite even when a tool is absent;
	// `runSecurityChecks` records the missing tool as skipped and the summary
	// fails closed instead of silently narrowing the security gate.
	const secretScanCommand = ["gitleaks", "detect", "--no-banner", "--redact"];
	const logOpts = process.env.SECURITY_SCAN_GITLEAKS_LOG_OPTS;
	if (logOpts && logOpts.length > 0) {
		secretScanCommand.push("--log-opts", logOpts);
	}
	const checks: SecurityCheck[] = [
		{
			name: "git-diff-check",
			command: gitDiffCheckCommand(),
			required: true,
		},
		{
			name: "bun-audit",
			command: ["bun", "audit"],
			required: true,
		},
		{
			name: "secret-scan",
			command: secretScanCommand,
			required: true,
		},
		{
			name: "workflow-security",
			command: ["zizmor", ".forgejo/workflows"],
			required: false,
		},
	];
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

export function securityCheckTimeoutMs(
	value = process.env.SECURITY_SCAN_TIMEOUT_MS,
): number {
	if (value === undefined || value.length === 0)
		return SECURITY_CHECK_TIMEOUT_MS;
	const timeoutMs = Number(value);
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new Error("SECURITY_SCAN_TIMEOUT_MS must be a positive number");
	}
	return timeoutMs;
}

export function runSecurityChecks(
	checks: SecurityCheck[] = defaultSecurityChecks(),
	cwd = repoRoot(),
	timeoutMs = securityCheckTimeoutMs(),
): SecurityResult[] {
	const results: SecurityResult[] = [];
	for (const check of checks) {
		const tool = check.command[0];
		if (!tool || Bun.which(tool) === null) {
			results.push({ ...check, status: "skipped", code: null });
			continue;
		}
		const result = spawnSync(check.command, {
			cwd,
			timeout: timeoutMs,
		});
		process.stdout.write(result.stdout);
		process.stderr.write(result.stderr);
		results.push({
			...check,
			status: result.timedOut
				? "timed-out"
				: result.code === 0
					? "passed"
					: "failed",
			code: result.code,
		});
	}
	return results;
}

export async function main(): Promise<void> {
	let timeoutMs: number;
	try {
		timeoutMs = securityCheckTimeoutMs();
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(2);
	}
	const results = runSecurityChecks(
		defaultSecurityChecks(),
		repoRoot(),
		timeoutMs,
	);
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
