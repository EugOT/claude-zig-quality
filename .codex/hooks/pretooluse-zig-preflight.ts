#!/usr/bin/env bun
/**
 * PreToolUse(Write|Edit|MultiEdit) — validate proposed .zig content via a
 * temporary file + `zig ast-check` before the edit lands. Exit 2 blocks the
 * edit; exit 0 allows it.
 *
 * Only fires for .zig files. All others pass through with exit 0.
 */
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
	appendJsonl,
	emitPreTool,
	readStdinJson,
	tail,
} from "../../scripts/lib/runtime.ts";
import { zig } from "../../scripts/lib/zig.ts";

type PreToolPayload = {
	tool_name?: string;
	tool_input?: {
		file_path?: string;
		content?: string;
		new_string?: string;
		edits?: Array<{ new_string?: string }>;
	};
};

async function main(): Promise<void> {
	const payload = await readStdinJson<PreToolPayload>();
	const tool = payload.tool_name ?? "";
	const file = payload.tool_input?.file_path ?? "";
	if (!file.endsWith(".zig")) {
		emitPreTool({ kind: "allow" });
	}

	// Codex P1: only Write provides full file content. Edit.new_string and
	// MultiEdit.edits[].new_string are *replacement fragments*, not complete
	// .zig sources — `zig ast-check` on a fragment fails for many valid
	// edits (e.g. replacing a single expression). Skip preflight on those
	// shapes; the post-tool hook still validates the resulting file.
	let proposed: string | undefined;
	if (tool === "Write") {
		proposed = payload.tool_input?.content;
	} else {
		emitPreTool({ kind: "allow" });
	}

	if (!proposed || proposed.length === 0) {
		emitPreTool({ kind: "allow" });
	}

	// Dump to temp file and run zig ast-check (0.16 accepts a path)
	const tmp = resolve(tmpdir(), `preflight-${Date.now()}.zig`);
	await Bun.write(tmp, proposed!);
	const r = zig(["ast-check", tmp]);

	await appendJsonl(".claude/logs/zig-preflight.jsonl", {
		event: r.code === 0 ? "pass" : "fail",
		file,
		tool,
		code: r.code,
	});

	if (r.code !== 0) {
		emitPreTool({
			kind: "pre-tool-decision",
			permissionDecision: "deny",
			permissionDecisionReason: `zig ast-check failed on proposed edit to ${file}:\n${tail(r.stderr || r.stdout, 1500)}`,
		});
	}
	emitPreTool({ kind: "allow" });
}

main().catch(async (err) => {
	await appendJsonl(".claude/logs/zig-preflight.jsonl", {
		event: "error",
		error: String(err),
	});
	console.error(`pretooluse-zig-preflight: ${String(err)}`);
	process.exit(1);
});
