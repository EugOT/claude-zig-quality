import { describe, expect, test } from "bun:test";
import {
	defaultSecurityChecks,
	runSecurityChecks,
	type SecurityResult,
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
		const checks = defaultSecurityChecks();
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
