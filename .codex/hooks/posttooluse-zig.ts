#!/usr/bin/env bun
/**
 * PostToolUse(Write|Edit|MultiEdit) — run fast scoped checks on the edited
 * .zig file and surface actionable failures as a block with repair context.
 *
 * Exit semantics (§2.1):
 *   0 → pass
 *   1 → log + warn (non-blocking)
 *   2 → block; Claude receives reason as repair context
 */
import {
	appendJsonl,
	emitPostTool,
	readStdinJson,
	tail,
} from "../../scripts/lib/runtime.ts";
import { zig } from "../../scripts/lib/zig.ts";

type PostToolPayload = {
	tool_name?: string;
	tool_input?: { file_path?: string };
};

// 0.14/0.15 drift patterns — grep blocks obvious hallucinations.
// Keep strict and short: each pattern here is a proven regression source.
const BANNED_API: Array<{ re: RegExp; fix: string }> = [
	{
		re: /std\.heap\.GeneralPurposeAllocator\b/,
		fix: "Use std.heap.DebugAllocator(.{}) in 0.16",
	},
	{
		re: /ArrayList\([A-Za-z_][A-Za-z0-9_]*\)\.init\s*\(/,
		fix: "Use `var list: ArrayList(T) = .empty;` and append(alloc, v) in 0.16",
	},
	{
		re: /std\.io\.getStdOut\s*\(\)/,
		fix: "Use std.fs.File.stdout() returning a writer that takes Io in 0.16",
	},
	{
		re: /\bThread\.Pool\b/,
		fix: "std.Thread.Pool removed in 0.16; use std.Io.async / Io.Group.async",
	},
	{
		re: /\busingnamespace\b/,
		fix: "usingnamespace removed in 0.15.1+; use explicit pub const re-exports",
	},
];

async function main(): Promise<void> {
	const payload = await readStdinJson<PostToolPayload>();
	const file = payload.tool_input?.file_path ?? "";
	if (!file.endsWith(".zig")) {
		emitPostTool({ kind: "allow" });
	}

	// zig fmt --check
	const fmt = zig(["fmt", "--check", file]);
	if (fmt.code !== 0) {
		await appendJsonl(".claude/logs/posttool-zig.jsonl", {
			event: "fmt-fail",
			file,
		});
		emitPostTool({
			kind: "block",
			reason: `zig fmt --check failed on ${file}. Run \`zig fmt ${file}\` and re-edit.\n${tail(fmt.stderr)}`,
		});
	}

	// zig ast-check
	const ast = zig(["ast-check", file]);
	if (ast.code !== 0) {
		await appendJsonl(".claude/logs/posttool-zig.jsonl", {
			event: "ast-fail",
			file,
		});
		emitPostTool({
			kind: "block",
			reason: `zig ast-check failed on ${file}:\n${tail(ast.stderr || ast.stdout, 1500)}`,
		});
	}

	// Banned-API grep for the 0.14/0.15 → 0.16 drift
	try {
		const content = await Bun.file(file).text();
		for (const { re, fix } of BANNED_API) {
			if (re.test(content)) {
				await appendJsonl(".claude/logs/posttool-zig.jsonl", {
					event: "banned-api",
					file,
					pattern: re.source,
				});
				emitPostTool({
					kind: "block",
					reason: `banned 0.14/0.15 API matched (${re.source}) in ${file}. Fix: ${fix}`,
				});
			}
		}
	} catch {
		// file may not exist (edge case on very fast deletes); fall through
	}

	await appendJsonl(".claude/logs/posttool-zig.jsonl", {
		event: "pass",
		file,
	});
	emitPostTool({ kind: "allow" });
}

main().catch(async (err) => {
	await appendJsonl(".claude/logs/posttool-zig.jsonl", {
		event: "error",
		error: String(err),
	});
	console.error(`posttooluse-zig: ${String(err)}`);
	process.exit(1);
});
