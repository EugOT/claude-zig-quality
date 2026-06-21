#!/usr/bin/env bun
/**
 * publish.ts — publish a claude-zig-quality status report into the canonical
 * report-host platform on himalayas (meshnet 100.100.39.44:4000).
 *
 * report-host (chezmoi apps/report_host) is the canonical, durable, launchd-
 * supervised Phoenix dashboard. Its publish contract is "write a JSON file";
 * the web process only reads. Schema (per report_live.ex):
 *   { title, observed_at, source,
 *     summary: [{label, value, note, state}],
 *     nodes:   [{name, state, kernel, os, note}],
 *     tasks:   [{title, note, state}],
 *     links:   [{label, url, note}] }
 * state ∈ ready | warn | error | info (drives the panel/dot color).
 *
 * This is the ADOPT-report-host path (ADR 0006, amended): claude-zig-quality
 * does NOT run its own server; it publishes a JSON snapshot. Multi-project:
 * writes reports/claude-zig-quality.json into REPORT_HOST_REPORTS_DIR (live on
 * report-host). The `--slot current` fallback writes the single current.json
 * alias and would overwrite other projects — avoid it unless intentional.
 *
 * Usage:
 *   bun report-platform/publish.ts                 # publish the built-in status
 *   bun report-platform/publish.ts --dry-run       # print JSON, do not scp
 *   bun report-platform/publish.ts --slot current  # write current.json (alias)
 *
 * Atomic remote write: scp to a temp file, then `mv` (rename) on the host.
 */
import { spawnSync } from "node:child_process";

// All host-specific values are env-overridable so this is portable across
// machines/users (the canonical defaults match the himalayas deployment).
const HOST = process.env.ZQ_REPORT_SSH_HOST || "himalayas";
const MESHNET = process.env.ZQ_REPORT_MESHNET || "100.100.39.44:4000";
const PROJECT = process.env.ZQ_REPORT_PROJECT || "claude-zig-quality";
const REMOTE_HOME = process.env.ZQ_REPORT_REMOTE_HOME || "~";
const REMOTE_REPORTS_DIR =
	process.env.ZQ_REPORT_REMOTE_DIR ||
	`${REMOTE_HOME}/.local/share/report-host/reports`;
const REMOTE_CURRENT =
	process.env.ZQ_REPORT_REMOTE_CURRENT ||
	`${REMOTE_HOME}/.local/share/report-host/current.json`;

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
// Writing the single shared current.json (the back-compat alias) is opt-in and
// explicit: it overwrites whatever other project published last, so require the
// exact `--slot=current` / `--slot current` form rather than a bare `current`.
const slotIdx = argv.indexOf("--slot");
const slotValue =
	(slotIdx !== -1 ? argv[slotIdx + 1] : undefined) ??
	argv.find((a) => a.startsWith("--slot="))?.slice("--slot=".length);
const slotCurrent = slotValue === "current";
if (slotIdx !== -1 && slotValue !== "current") {
	console.error(
		`publish: --slot only supports "current"; got ${JSON.stringify(slotValue)}`,
	);
	process.exit(2);
}

// ---- The live status of the hardening effort (edit as work progresses) ----
// This IS the live progress tracker. `state` colors each item.
type State = "ready" | "warn" | "error" | "info";
type Task = { title: string; note: string; state: State };

const tasks: Task[] = [
	{
		title:
			"Phase 1 — reproducible build (SOURCE_DATE_EPOCH + Mach-O normalize)",
		note: "MERGED to main (PR #9, d945a7b7). 33/33 tests.",
		state: "ready",
	},
	{
		title: "Report platform reconciled — adopt report-host",
		note: "Killed :4000 squatter; retired redundant zq-reports :4010; report-host canonical.",
		state: "ready",
	},
	{
		title: "#13 Multi-project reports dir + index in report-host",
		note: "DONE: REPORT_HOST_REPORTS_DIR + /r/:slug live; 17 tests; pz back-compat preserved; deployed to himalayas.",
		state: "ready",
	},
	{
		title: "#14 Publish claude-zig-quality report into report-host",
		note: "DONE: this very page — published reports/claude-zig-quality.json, renders at /r/claude-zig-quality.",
		state: "ready",
	},
	{
		title: "#12 Resolve PR #10 (redundant zq-reports server)",
		note: "NEXT: repurpose to adopt-report-host docs / publisher; remove competing server.",
		state: "info",
	},
	{
		title: "#15 Phase 2 — cosign env validation (release tier)",
		note: "QUEUED: checkCosignEnv() + verify-blob + SBOM schema, one release-tier PR.",
		state: "info",
	},
	{
		title: "report-host CSS assets not served in prod release",
		note: "Follow-up: page renders unstyled — prod release needs digested CSS (mix assets.deploy).",
		state: "warn",
	},
];

const summary = [
	{
		label: "Phase 1 (reproducibility)",
		value: "MERGED",
		note: "PR #9 on main; SDE + Mach-O UUID normalize",
		state: "ready" as State,
	},
	{
		label: "Report platform",
		value: "report-host canonical",
		note: ":4000 restored; zq-reports retired",
		state: "ready" as State,
	},
	{
		label: "Multi-report platform",
		value: "LIVE",
		note: "#13 reports-dir + /r/:slug deployed; #14 this report published",
		state: "ready" as State,
	},
	{
		label: "Next",
		value: "2 tasks",
		note: "#12 repurpose PR#10 · #15 Phase 2 (cosign)",
		state: "info" as State,
	},
	{
		label: "Live conflict",
		value: "resolved",
		note: "killed pr_dashboard :4000 squatter",
		state: "ready" as State,
	},
];

const links = [
	{
		label: "PR #9 — Phase 1 reproducibility (merged)",
		url: "https://github.com/EugOT/claude-zig-quality/pull/9",
		note: "SOURCE_DATE_EPOCH + Mach-O normalize",
	},
	{
		label: "PR #10 — report-platform (under review)",
		url: "https://github.com/EugOT/claude-zig-quality/pull/10",
		note: "being repurposed to adopt-report-host",
	},
	{
		label: "ADR 0005 — reproducibility Darwin UUID",
		url: "https://github.com/EugOT/claude-zig-quality/blob/main/doc/adr/0005-reproducibility-darwin-uuid.md",
		note: "",
	},
	{
		label: "ADR 0006 — report platform",
		url: "https://github.com/EugOT/claude-zig-quality/blob/main/doc/adr/0006-report-platform.md",
		note: "superseded by report-host adoption",
	},
];

const report = {
	title: "claude-zig-quality — hardening progress",
	observed_at: new Date().toISOString(),
	source:
		"published by report-platform/publish.ts from EugOT/claude-zig-quality",
	summary,
	nodes: [], // claude-zig-quality has no node fleet; section renders empty
	tasks,
	links,
};

const json = `${JSON.stringify(report, null, 2)}\n`;

if (dryRun) {
	process.stdout.write(json);
	console.error(`\n(dry-run: would publish ${json.length}b for ${PROJECT})`);
	process.exit(0);
}

// Decide remote slot. Prefer the multi-project reports dir; fall back to the
// single current.json alias only when explicitly asked (it overwrites other
// projects' reports until task #13 lands).
const remotePath = slotCurrent
	? REMOTE_CURRENT
	: `${REMOTE_REPORTS_DIR}/${PROJECT}.json`;
// Unique temp name generated client-side — do NOT rely on the remote shell
// expanding `$$` (fragile: an unset/non-expanding shell would create a literal
// ".tmp.$$" file and the rename would still "work" but races between concurrent
// publishers would collide). A random suffix is collision-safe per invocation.
const tmpPath = `${remotePath}.tmp.${crypto.randomUUID()}`;

function ssh(cmd: string) {
	return spawnSync(
		"ssh",
		["-o", "ConnectTimeout=10", "-o", "BatchMode=yes", HOST, cmd],
		{ encoding: "utf8" },
	);
}

// Ensure the reports dir exists (no-op for the current.json alias).
if (!slotCurrent) {
	const mk = ssh(`mkdir -p ${REMOTE_REPORTS_DIR}`);
	if (mk.status !== 0) {
		console.error("publish: cannot create remote reports dir:", mk.stderr);
		process.exit(1);
	}
}

// Atomic write: pipe JSON to a temp file via ssh, then rename.
const write = spawnSync(
	"ssh",
	[
		"-o",
		"ConnectTimeout=10",
		"-o",
		"BatchMode=yes",
		HOST,
		`cat > ${tmpPath} && mv -f ${tmpPath} ${remotePath}`,
	],
	{ input: json, encoding: "utf8" },
);
if (write.status !== 0) {
	console.error("publish: remote write failed:", write.stderr);
	process.exit(1);
}

console.log(`published ${PROJECT} (${json.length}b) -> ${HOST}:${remotePath}`);
console.log(
	`view: http://${MESHNET}/  (or /r/${PROJECT} once the multi-report index lands)`,
);
