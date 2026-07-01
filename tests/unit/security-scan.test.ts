import { describe, expect, test } from "bun:test";
import {
	defaultSecurityChecks,
	gitDiffCheckCommand,
	runSecurityChecks,
	type SecurityResult,
	securityCheckTimeoutMs,
	summarizeSecurity,
} from "../../scripts/security-scan.ts";

describe("security-scan summary", () => {
	test("fails only on required failed checks", () => {
		const results: SecurityResult[] = [
			{
				name: "required",
				command: ["tool"],
				required: true,
				status: "failed",
				code: 1,
			},
			{
				name: "optional",
				command: ["tool"],
				required: false,
				status: "failed",
				code: 1,
			},
		];
		expect(summarizeSecurity(results)).toEqual({
			ok: false,
			failedRequired: ["required"],
		});
	});

	test("passes when optional checks fail but required checks pass", () => {
		const results: SecurityResult[] = [
			{
				name: "required",
				command: ["tool"],
				required: true,
				status: "passed",
				code: 0,
			},
			{
				name: "optional",
				command: ["tool"],
				required: false,
				status: "failed",
				code: 1,
			},
		];
		expect(summarizeSecurity(results)).toEqual({
			ok: true,
			failedRequired: [],
		});
	});

	test("fails when required checks are skipped", () => {
		const results: SecurityResult[] = [
			{
				name: "required-missing",
				command: ["tool"],
				required: true,
				status: "skipped",
				code: null,
			},
		];
		expect(summarizeSecurity(results)).toEqual({
			ok: false,
			failedRequired: ["required-missing"],
		});
	});

	test("fails when required checks time out", () => {
		const results: SecurityResult[] = [
			{
				name: "required-timeout",
				command: ["tool"],
				required: true,
				status: "timed-out",
				code: null,
			},
		];
		expect(summarizeSecurity(results)).toEqual({
			ok: false,
			failedRequired: ["required-timeout"],
		});
	});
});
describe("security-scan runner", () => {
	test("keeps required default checks even when tools are absent", () => {
		const savedLogOpts = process.env.SECURITY_SCAN_GITLEAKS_LOG_OPTS;
		delete process.env.SECURITY_SCAN_GITLEAKS_LOG_OPTS;
		const checks = defaultSecurityChecks();
		try {
			const requiredNames = checks
				.filter((check) => check.required)
				.map((check) => check.name);
			expect(requiredNames).toContain("git-diff-check");
			expect(requiredNames).toContain("bun-audit");
			expect(requiredNames).toContain("secret-scan");
			expect(checks).toContainEqual({
				name: "workflow-security",
				command: ["zizmor", ".forgejo/workflows"],
				required: false,
			});
			expect(checks.find((check) => check.name === "secret-scan")).toEqual({
				name: "secret-scan",
				command: ["gitleaks", "detect", "--no-banner", "--redact"],
				required: true,
			});
		} finally {
			if (savedLogOpts === undefined)
				delete process.env.SECURITY_SCAN_GITLEAKS_LOG_OPTS;
			else process.env.SECURITY_SCAN_GITLEAKS_LOG_OPTS = savedLogOpts;
		}
	});

	test("uses gitleaks log opts only when explicitly configured", () => {
		const savedLogOpts = process.env.SECURITY_SCAN_GITLEAKS_LOG_OPTS;
		process.env.SECURITY_SCAN_GITLEAKS_LOG_OPTS = "--max-count=20";
		try {
			expect(defaultSecurityChecks()).toContainEqual({
				name: "secret-scan",
				command: [
					"gitleaks",
					"detect",
					"--no-banner",
					"--redact",
					"--log-opts",
					"--max-count=20",
				],
				required: true,
			});
		} finally {
			if (savedLogOpts === undefined)
				delete process.env.SECURITY_SCAN_GITLEAKS_LOG_OPTS;
			else process.env.SECURITY_SCAN_GITLEAKS_LOG_OPTS = savedLogOpts;
		}
	});

	test("allows slow lanes to configure the required scan timeout", () => {
		expect(securityCheckTimeoutMs(undefined)).toBe(120_000);
		expect(securityCheckTimeoutMs("300000")).toBe(300_000);
		expect(() => securityCheckTimeoutMs("0")).toThrow("positive number");
		expect(() => securityCheckTimeoutMs("not-a-number")).toThrow(
			"positive number",
		);
	});

	test("uses commit-range git diff checks in CI", () => {
		expect(
			gitDiffCheckCommand({ SECURITY_SCAN_GIT_DIFF_RANGE: "main...HEAD" }),
		).toEqual(["git", "diff", "--check", "main...HEAD"]);
		expect(gitDiffCheckCommand({ GITHUB_BASE_SHA: "abc123" })).toEqual([
			"git",
			"diff",
			"--check",
			"abc123...HEAD",
		]);
		const mergeBaseCommand = gitDiffCheckCommand({ GITHUB_BASE_REF: "main" });
		expect(mergeBaseCommand[0]).toBe("sh");
		expect(mergeBaseCommand.at(-1)).toContain(
			"git merge-base HEAD 'origin/main'",
		);
		expect(mergeBaseCommand.at(-1)).toContain("git diff --check");
		const slashBranchCommand = gitDiffCheckCommand({
			GITHUB_BASE_REF: "release/1.x",
		});
		expect(slashBranchCommand[0]).toBe("sh");
		expect(slashBranchCommand.at(-1)).toContain(
			"git merge-base HEAD 'origin/release/1.x'",
		);
		expect(slashBranchCommand.at(-1)).toContain("git diff --check");
	});

	test("marks missing tools as skipped", () => {
		const results = runSecurityChecks([
			{
				name: "missing",
				command: ["/definitely/not/a/tool"],
				required: true,
			},
		]);
		expect(results).toEqual([
			{
				name: "missing",
				command: ["/definitely/not/a/tool"],
				required: true,
				status: "skipped",
				code: null,
			},
		]);
	});

	test("runs available commands and records exit status", () => {
		const results = runSecurityChecks(
			[
				{
					name: "shell-pass",
					command: ["sh", "-c", "exit 0"],
					required: true,
				},
				{
					name: "shell-fail",
					command: ["sh", "-c", "exit 7"],
					required: true,
				},
			],
			process.cwd(),
		);
		expect(results.map((r) => [r.name, r.status, r.code])).toEqual([
			["shell-pass", "passed", 0],
			["shell-fail", "failed", 7],
		]);
	});

	test("marks commands that exceed the timeout", () => {
		const results = runSecurityChecks(
			[
				{
					name: "shell-timeout",
					command: ["sh", "-c", "sleep 1"],
					required: true,
				},
			],
			process.cwd(),
			10,
		);
		expect(results).toEqual([
			{
				name: "shell-timeout",
				command: ["sh", "-c", "sleep 1"],
				required: true,
				status: "timed-out",
				code: null,
			},
		]);
	});
});
