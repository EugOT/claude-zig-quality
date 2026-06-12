#!/usr/bin/env bun
/**
 * PreToolUse(Bash) hook. Denies destructive shell patterns and also carries
 * the v0 warn-only MCP-tool-name scan per plan §10.5 row V2. The full
 * classifier-backed MCP scanner is deferred to v1 (Open Question §10.12).
 *
 * Exit semantics (§2.1):
 *   0 → allow (stdout JSON = permissionDecision: allow)
 *   1 → allow + warn in transcript
 *   2 → block the Bash call; stderr is the reason
 */
import {
	appendJsonl,
	emitPreTool,
	readStdinJson,
} from "../../scripts/lib/runtime.ts";

type PreToolPayload = {
	tool_name?: string;
	tool_input?: { command?: string };
};

const DENY_PATTERNS: RegExp[] = [
	/\brm\s+-rf?\s+\//,
	/\bgit\s+push\s+(--force|-f)\b/,
	/\bgit\s+push\s+--force-with-lease\s+origin\s+main\b/,
	/\bgit\s+tag\b/,
	/\bcosign\b/,
	/\bchezmoi\s+purge\b/,
	/\bjj\s+(undo|abandon|op\s+restore)\b/,
	/\bdd\s+if=.*\s+of=\/dev\/(?:disk|sd)/,
];

// Known MCP tool prefixes that return potentially untrusted text.
// Warn-only: log to .claude/logs/mcp-scan.jsonl; never block in v0.
const UNTRUSTED_INSTR_MARKERS: RegExp[] = [
	/ignore\s+previous\s+instructions/i,
	/system\s+note\s*:/i,
	/\{\{\s*secret/i,
];

async function main(): Promise<void> {
	const payload = await readStdinJson<PreToolPayload>();
	const toolName = payload.tool_name ?? "";
	const cmd = payload.tool_input?.command ?? "";

	// Destructive-command guard
	for (const re of DENY_PATTERNS) {
		if (re.test(cmd)) {
			await appendJsonl(".claude/logs/bash-guard.jsonl", {
				event: "deny",
				pattern: re.source,
				command: cmd,
			});
			emitPreTool({
				kind: "pre-tool-decision",
				permissionDecision: "deny",
				permissionDecisionReason: `pretooluse-bash-guard: blocked ${re.source} in "${cmd}". Use a reversible alternative or ask the user.`,
			});
		}
	}

	// Warn-only MCP content scan (plan §10.5 V2 adapted)
	if (toolName.startsWith("mcp__")) {
		const text = JSON.stringify(payload.tool_input ?? {});
		const hits = UNTRUSTED_INSTR_MARKERS.filter((re) => re.test(text)).map(
			(re) => re.source,
		);
		await appendJsonl(".claude/logs/mcp-scan.jsonl", {
			event: "mcp-pretool-scan",
			tool: toolName,
			markersHit: hits,
		});
		if (hits.length > 0) {
			console.error(
				`pretooluse-bash-guard: MCP call to ${toolName} contains injection markers (${hits.join(", ")}). v0 warn-only; logged.`,
			);
		}
	}

	await appendJsonl(".claude/logs/bash-guard.jsonl", {
		event: "allow",
		tool: toolName,
	});
	emitPreTool({ kind: "allow" });
}

main().catch(async (err) => {
	await appendJsonl(".claude/logs/bash-guard.jsonl", {
		event: "error",
		error: String(err),
	});
	console.error(`pretooluse-bash-guard: ${String(err)}`);
	process.exit(1);
});
