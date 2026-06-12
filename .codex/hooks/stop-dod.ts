#!/usr/bin/env bun
/**
 * Stop hook — Definition of Done gate. Runs `bun scripts/verify-commit.ts`
 * before the agent can stop. Guarded by `stop_hook_active` to prevent
 * infinite loops.
 *
 * Exit semantics (§2.1):
 *   0 → allow stop
 *   1 → log + warn (non-blocking)
 *   2 → force continuation; stderr is the repair context
 */
import {
	appendJsonl,
	readStdinJson,
	repoRoot,
	spawnSync,
	tail,
} from "../../scripts/lib/runtime.ts";

type StopPayload = {
	stop_hook_active?: boolean;
};

async function main(): Promise<void> {
	const payload = await readStdinJson<StopPayload>();
	if (payload.stop_hook_active === true) {
		// Second-pass stop: allow to prevent infinite loops (§0.9 rationale).
		await appendJsonl(".claude/logs/stop-dod.jsonl", {
			event: "stop-active-allow",
		});
		process.exit(0);
	}

	const r = spawnSync(["bun", "scripts/verify-commit.ts"], {
		cwd: repoRoot(),
	});
	await appendJsonl(".claude/logs/stop-dod.jsonl", {
		event: r.code === 0 ? "pass" : "fail",
		code: r.code,
	});

	if (r.code !== 0) {
		console.log(
			JSON.stringify({
				decision: "block",
				reason: `Definition-of-Done gate failed (bun scripts/verify-commit.ts). Fix the failures and try again:\n${tail(r.stderr || r.stdout)}`,
			}),
		);
		process.exit(0);
	}
	process.exit(0);
}

main().catch(async (err) => {
	await appendJsonl(".claude/logs/stop-dod.jsonl", {
		event: "error",
		error: String(err),
	});
	console.error(`stop-dod: ${String(err)}`);
	process.exit(1);
});
