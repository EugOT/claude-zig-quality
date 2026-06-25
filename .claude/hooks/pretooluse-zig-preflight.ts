#!/usr/bin/env bun
/**
 * PreToolUse(Write|Edit|MultiEdit) — validate proposed .zig content via a
 * temporary file + `zig ast-check` before the edit lands. Exit 2 blocks the
 * edit; exit 0 allows it.
 *
 * Only fires for .zig files. All others pass through with exit 0.
 */
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
	appendJsonl,
	emitPreTool,
	readStdinJson,
	tail,
} from "../../scripts/lib/runtime.ts";
import { zig as realZig } from "../../scripts/lib/zig.ts";

type PreToolPayload = {
	tool_name?: string;
	tool_input?: {
		file_path?: string;
		content?: string;
		new_string?: string;
		edits?: Array<{ new_string?: string }>;
	};
};

export async function main(zig: typeof realZig = realZig): Promise<void> {
	const payload = await readStdinJson<PreToolPayload>();
	const tool = payload.tool_name ?? "";
	const file = payload.tool_input?.file_path ?? "";
	if (!file.endsWith(".zig")) {
		emitPreTool({ kind: "allow" });
		return;
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
		return;
	}

	if (!proposed || proposed.length === 0) {
		emitPreTool({ kind: "allow" });
		return;
	}
	// `proposed` is now a non-empty string (the guard above exits otherwise),
	// so no non-null assertion is needed downstream.
	const source: string = proposed;

	// Dump to a per-invocation temp file and run zig ast-check (0.16 accepts a
	// path). A unique UUID name avoids the cross-invocation collision that a
	// shared static path (or `Date.now()`) hits under concurrent edits, where
	// one invocation could validate another's contents. Clean up in `finally`
	// so the temp file never leaks regardless of the ast-check outcome.
	const tmp = resolve(tmpdir(), `preflight-${crypto.randomUUID()}.zig`);
	let code: number | null;
	let diagnostic: string;
	try {
		await Bun.write(tmp, source);
		const r = zig(["ast-check", tmp]);
		code = r.code;
		diagnostic = tail(r.stderr || r.stdout, 1500);
	} finally {
		await rm(tmp, { force: true });
	}

	await appendJsonl(".claude/logs/zig-preflight.jsonl", {
		event: code === 0 ? "pass" : "fail",
		file,
		tool,
		code,
	});

	if (code !== 0) {
		emitPreTool({
			kind: "pre-tool-decision",
			permissionDecision: "deny",
			permissionDecisionReason: `zig ast-check failed on proposed edit to ${file}:\n${diagnostic}`,
		});
		return;
	}
	emitPreTool({ kind: "allow" });
	return;
}

if (import.meta.main) {
	main().catch(async (err) => {
		await appendJsonl(".claude/logs/zig-preflight.jsonl", {
			event: "error",
			error: String(err),
		});
		console.error(`pretooluse-zig-preflight: ${String(err)}`);
		process.exit(1);
	});
}
