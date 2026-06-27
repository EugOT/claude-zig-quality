import { describe, expect, test } from "bun:test";
import {
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
});
describe("security-scan runner", () => {
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
});
