#!/usr/bin/env bun
/**
 * CEL-461 workflow program: reusable Zig kcov workflow templates.
 *
 * This file is the coordination artifact for resuming CEL-461/CEL-464/CEL-465
 * work. It is intentionally programmatic: thread ownership, dependencies,
 * prompts, safety gates, and validation steps are represented as typed data and
 * checked at runtime before any implementation continuation.
 */

type IssueId = `CEL-${number}`;
type ThreadId =
	| "coordination-status"
	| "repo-coverage-review"
	| "platform-orbstack-review"
	| "ci-security-review"
	| "qa-validation"
	| "live-report";

type Lane = "macos-native" | "orbstack-linux" | "ci-linux";
type RiskLevel =
	| "safe-read"
	| "local-write"
	| "system-mutation"
	| "remote-mutation";
type SourceKind =
	| "implementation-source"
	| "reference-documentation"
	| "issue-tracker"
	| "workflow-config"
	| "test-fixture"
	| "security-standard";
type SourceQuality =
	| "primary"
	| "repo-local"
	| "connector-live"
	| "memory-derived";
type ThreadStatus = "ready" | "blocked" | "complete" | "pending-validation";

type ResearchSource = {
	readonly id: string;
	readonly kind: SourceKind;
	readonly quality: SourceQuality;
	readonly relatedness: "direct" | "supporting" | "context";
	readonly usefulness: "high" | "medium" | "low";
	readonly recency: string;
	readonly notes: string;
	readonly locations: readonly string[];
};

type SafetyGate = {
	readonly id: string;
	readonly risk: RiskLevel;
	readonly appliesTo: readonly string[];
	readonly confirmationRequired: boolean;
	readonly rule: string;
};

type ValidationStep = {
	readonly command: string;
	readonly lane: Lane | "linear" | "report-host";
	readonly mutatesSystem: boolean;
	readonly requiredForAcceptance: boolean;
	readonly expected: string;
};

type AgentRole = {
	readonly name: string;
	readonly modelIntent:
		| "haiku-readonly"
		| "sonnet-implementation"
		| "opus-review";
	readonly scope: string;
	readonly tools: readonly string[];
};

type ThreadSpec = {
	readonly id: ThreadId;
	readonly issueIds: readonly IssueId[];
	readonly status: ThreadStatus;
	readonly scope: string;
	readonly dependencies: readonly ThreadId[];
	readonly inputs: readonly string[];
	readonly outputs: readonly string[];
	readonly blockers: readonly string[];
	readonly readGlobs: readonly string[];
	readonly writeGlobs: readonly string[];
	readonly forbiddenGlobs: readonly string[];
	readonly commands: readonly ValidationStep[];
	readonly mcpAndApps: readonly string[];
	readonly docs: readonly string[];
	readonly roles: readonly AgentRole[];
	readonly optimizedPrompt: string;
	readonly synchronization: string;
};

type WorkflowProgram = {
	readonly slug: string;
	readonly reportUrl: string;
	readonly repository: string;
	readonly observationStamp: {
		readonly observedAt: string;
		readonly branch: string;
		readonly head: string;
		readonly dirtyState: readonly string[];
		readonly linearState: readonly string[];
	};
	readonly statusAnswer: string;
	readonly researchSources: readonly ResearchSource[];
	readonly safetyGates: readonly SafetyGate[];
	readonly threads: readonly ThreadSpec[];
	readonly qaCycles: readonly string[];
	readonly acceptanceCriteria: readonly string[];
	readonly iterativeImprovement: readonly string[];
	readonly explicitApprovalRequiredFor: readonly string[];
};

const workflow = {
	slug: "cel-461-kcov-status",
	reportUrl: "https://report.cordillera.home/r/cel-461-kcov-status",
	repository: "github.com/EugOT/claude-zig-quality",
	observationStamp: {
		observedAt: "2026-07-01T13:58:00+02:00",
		branch: "test/cel-461-reusable-kcov-templates",
		head: "dac65a985a190f9de943f6ad7959d888be509e80",
		dirtyState: [
			"scripts/verify-release.ts SBOM validation change reviewed and covered by tests.",
			".jj is untracked.",
			".agents/workflows/cel-461-kcov-status.workflow.ts is this coordination artifact.",
		],
		linearState: [
			"CEL-461 claude-zig-quality: add reusable Zig kcov workflow templates is Done in Linear.",
			"CEL-464 Add mandatory security and supply-chain gates to Zig workflow is In Progress.",
			"CEL-465 Run final multi-repo validation and PR split is Backlog.",
		],
	},
	statusAnswer:
		"CEL-461 implementation and local validation are complete on this branch; PR publication and CI result collection remain.",
	researchSources: [
		{
			id: "repo-current-implementation",
			kind: "implementation-source",
			quality: "repo-local",
			relatedness: "direct",
			usefulness: "high",
			recency: "Live repo inspection on 2026-06-28",
			notes:
				"Branch contains coverage-linux, coverage-docker, orbstack-linux, security-scan, platform lane detection, coverage-security workflow, Dockerfile, templates, ADR 0007, skill references, and unit tests.",
			locations: [
				"scripts/coverage-linux.ts",
				"scripts/coverage-docker.ts",
				"scripts/orbstack-linux.ts",
				"scripts/security-scan.ts",
				"scripts/lib/platform.ts",
				".forgejo/workflows/coverage-security.yaml",
				"templates/forgejo/coverage-security.yaml",
				"docker/coverage.Dockerfile",
			],
		},
		{
			id: "src-lib-real-logic",
			kind: "implementation-source",
			quality: "repo-local",
			relatedness: "direct",
			usefulness: "high",
			recency: "Live repo inspection on 2026-06-28",
			notes:
				"src/lib.zig is real public API logic and must stay inside coverage targets; do not copy gitstore-cli exclusions blindly.",
			locations: [
				"src/lib.zig",
				"scripts/coverage-linux.ts",
				"tests/unit/coverage-linux.test.ts",
			],
		},
		{
			id: "linear-tracker",
			kind: "issue-tracker",
			quality: "connector-live",
			relatedness: "direct",
			usefulness: "high",
			recency: "Linear connector read on 2026-06-28",
			notes:
				"Development Workflow Reliability Upgrade is the tracker; CEL-461 Done, CEL-464 In Progress, CEL-465 Backlog.",
			locations: ["Linear project Development Workflow Reliability Upgrade"],
		},
		{
			id: "kcov-docs",
			kind: "reference-documentation",
			quality: "primary",
			relatedness: "direct",
			usefulness: "medium",
			recency: "Checked on 2026-06-28",
			notes:
				"kcov behavior should be verified against primary project docs/source when adjusting output parsing or include/exclude policy.",
			locations: ["kcov upstream documentation/source"],
		},
		{
			id: "github-actions-security",
			kind: "security-standard",
			quality: "primary",
			relatedness: "supporting",
			usefulness: "high",
			recency: "Checked on 2026-06-28",
			notes:
				"Workflow hardening should keep least-privilege permissions, avoid privileged untrusted PR execution, and prefer pinned actions.",
			locations: ["GitHub Actions security hardening docs", "SLSA v1.2 docs"],
		},
		{
			id: "orbstack-docs",
			kind: "reference-documentation",
			quality: "primary",
			relatedness: "direct",
			usefulness: "high",
			recency: "Checked on 2026-06-28",
			notes:
				"OrbStack Linux machines and orb CLI are the intended local Linux lane, but they are not a substitute for CI merge authority.",
			locations: ["OrbStack Linux machines docs", "OrbStack headless/CLI docs"],
		},
	],
	safetyGates: [
		{
			id: "no-concurrent-overwrite",
			risk: "local-write",
			appliesTo: ["scripts/verify-release.ts"],
			confirmationRequired: true,
			rule: "Do not edit or revert scripts/verify-release.ts until the concurrent diff owner or user explicitly approves.",
		},
		{
			id: "no-destructive-vcs",
			risk: "local-write",
			appliesTo: [
				"git reset",
				"git checkout --",
				"jj undo",
				"jj abandon",
				"jj op restore",
			],
			confirmationRequired: true,
			rule: "Destructive VCS cleanup is unsafe by default.",
		},
		{
			id: "system-provisioning",
			risk: "system-mutation",
			appliesTo: [
				"orb create",
				"docker build",
				"docker run",
				"pacman",
				"mise use -g",
			],
			confirmationRequired: true,
			rule: "Provisioning and container execution require an explicit go-ahead and must report resource impact.",
		},
		{
			id: "remote-publication",
			risk: "remote-mutation",
			appliesTo: [
				"gh pr create",
				"git push",
				"Linear comments/documents",
				"report-host publish",
			],
			confirmationRequired: true,
			rule: "Remote writes wait for user approval unless explicitly requested in the current turn.",
		},
	],
	threads: [
		{
			id: "coordination-status",
			issueIds: ["CEL-461", "CEL-464", "CEL-465"],
			status: "complete",
			scope:
				"Create and maintain this typed workflow artifact; preserve live status, ownership, thread boundaries, and blockers.",
			dependencies: [],
			inputs: [
				"git status",
				"git log",
				"Linear project issue list",
				"repo file inventory",
			],
			outputs: [
				".agents/workflows/cel-461-kcov-status.workflow.ts",
				"status report",
			],
			blockers: [],
			readGlobs: ["**/*"],
			writeGlobs: [".agents/workflows/cel-461-kcov-status.workflow.ts"],
			forbiddenGlobs: ["scripts/verify-release.ts"],
			commands: [
				{
					command: "git status --short --branch",
					lane: "macos-native",
					mutatesSystem: false,
					requiredForAcceptance: true,
					expected: "Reports branch, concurrent edits, and new workflow file.",
				},
				{
					command: "bun .agents/workflows/cel-461-kcov-status.workflow.ts",
					lane: "macos-native",
					mutatesSystem: false,
					requiredForAcceptance: true,
					expected: "Runtime ownership/dependency validation passes.",
				},
			],
			mcpAndApps: ["Linear read-only"],
			docs: [
				"CLAUDE.md",
				"doc/adr/0007-platform-coverage-security-workflow.md",
			],
			roles: [
				{
					name: "workflow-owner",
					modelIntent: "sonnet-implementation",
					scope: "Own only the workflow artifact and status report.",
					tools: ["Read", "rg", "git status", "Linear read"],
				},
			],
			optimizedPrompt:
				"Inspect live repo and Linear state, then update only .agents/workflows/cel-461-kcov-status.workflow.ts with typed coordination data. Do not edit implementation files. Preserve concurrent verify-release.ts diff as a blocker.",
			synchronization:
				"All other threads consume this file as the handoff contract and append findings through future narrow patches.",
		},
		{
			id: "repo-coverage-review",
			issueIds: ["CEL-461"],
			status: "pending-validation",
			scope:
				"Review coverage scripts and source targets for correctness, especially src/lib.zig inclusion and kcov summary parsing.",
			dependencies: ["coordination-status"],
			inputs: [
				"scripts/coverage-linux.ts",
				"scripts/coverage-docker.ts",
				"src/*.zig",
				"tests/unit/coverage*.test.ts",
			],
			outputs: [
				"coverage target audit",
				"coverage parser findings",
				"optional narrow fixes",
			],
			blockers: [
				"Need Linux or Docker/OrbStack run for measured kcov evidence.",
			],
			readGlobs: [
				"scripts/coverage-*.ts",
				"src/*.zig",
				"tests/unit/coverage*.test.ts",
				"coverage/summary.json",
			],
			writeGlobs: [
				"scripts/coverage-linux.ts",
				"scripts/coverage-docker.ts",
				"tests/unit/coverage-linux.test.ts",
				"tests/unit/coverage-docker.test.ts",
			],
			forbiddenGlobs: ["scripts/verify-release.ts"],
			commands: [
				{
					command:
						"bun test tests/unit/coverage-linux.test.ts tests/unit/coverage-docker.test.ts",
					lane: "macos-native",
					mutatesSystem: false,
					requiredForAcceptance: true,
					expected: "Coverage unit tests pass.",
				},
				{
					command: "bun scripts/coverage-linux.ts --fail-under-lines 95",
					lane: "orbstack-linux",
					mutatesSystem: false,
					requiredForAcceptance: true,
					expected:
						"Measured Linux kcov coverage passes, including src/lib.zig.",
				},
			],
			mcpAndApps: [],
			docs: [
				"kcov upstream docs/source",
				".claude/skills/zig-quality/references/platform-coverage-security.md",
			],
			roles: [
				{
					name: "coverage-auditor",
					modelIntent: "haiku-readonly",
					scope: "Find target or parser mistakes without editing.",
					tools: ["Read", "rg", "bun test"],
				},
				{
					name: "coverage-fixer",
					modelIntent: "sonnet-implementation",
					scope: "Apply only reviewed coverage script/test fixes.",
					tools: ["apply_patch", "bun test"],
				},
			],
			optimizedPrompt:
				"Audit coverage-linux and coverage-docker for CEL-461. Confirm src/lib.zig is covered as real logic, parser handles kcov JSON, and Docker lane is fail-closed. Return exact file/line findings and do not edit verify-release.ts.",
			synchronization:
				"Must not overlap with CI/security workflow edits except through tests/unit/coverage-security-yaml.test.ts coordination.",
		},
		{
			id: "platform-orbstack-review",
			issueIds: ["CEL-461"],
			status: "pending-validation",
			scope:
				"Review OrbStack lane command construction, provisioning templates, and lane authority claims.",
			dependencies: ["coordination-status"],
			inputs: [
				"scripts/orbstack-linux.ts",
				"scripts/lib/platform.ts",
				"templates/orbstack/*",
			],
			outputs: [
				"OrbStack dry-run evidence",
				"provisioning blocker list",
				"optional narrow fixes",
			],
			blockers: [
				"Actual orb execution requires local OrbStack availability and user approval.",
			],
			readGlobs: [
				"scripts/orbstack-linux.ts",
				"scripts/lib/platform.ts",
				"templates/orbstack/*",
				"tests/unit/orbstack-linux.test.ts",
				"tests/unit/platform.test.ts",
			],
			writeGlobs: [
				"scripts/orbstack-linux.ts",
				"scripts/lib/platform.ts",
				"templates/orbstack/*",
				"tests/unit/orbstack-linux.test.ts",
				"tests/unit/platform.test.ts",
			],
			forbiddenGlobs: ["scripts/verify-release.ts"],
			commands: [
				{
					command:
						"bun test tests/unit/orbstack-linux.test.ts tests/unit/platform.test.ts",
					lane: "macos-native",
					mutatesSystem: false,
					requiredForAcceptance: true,
					expected: "OrbStack and platform unit tests pass.",
				},
				{
					command: "bun scripts/orbstack-linux.ts --dry-run",
					lane: "macos-native",
					mutatesSystem: false,
					requiredForAcceptance: true,
					expected: "Prints exact orb command without running it.",
				},
			],
			mcpAndApps: [],
			docs: [
				"OrbStack Linux machines docs",
				"OrbStack CLI/headless docs",
				"doc/adr/0007-platform-coverage-security-workflow.md",
			],
			roles: [
				{
					name: "platform-auditor",
					modelIntent: "haiku-readonly",
					scope: "Check lane authority and command construction.",
					tools: ["Read", "rg", "bun test"],
				},
			],
			optimizedPrompt:
				"Review platform lane detection and OrbStack wrappers. Confirm macOS, OrbStack Linux, and CI Linux claims stay separated. Use dry-run only unless explicitly approved.",
			synchronization:
				"Reports lane facts to repo-coverage-review and ci-security-review; does not own workflow YAML.",
		},
		{
			id: "ci-security-review",
			issueIds: ["CEL-464"],
			status: "pending-validation",
			scope:
				"Review coverage-security workflow, supply-chain gates, Dockerfile pinning, and optional scanner behavior.",
			dependencies: ["coordination-status"],
			inputs: [
				".forgejo/workflows/coverage-security.yaml",
				"templates/forgejo/coverage-security.yaml",
				"docker/coverage.Dockerfile",
				"scripts/security-scan.ts",
			],
			outputs: [
				"security gate findings",
				"workflow hardening checklist",
				"optional narrow fixes",
			],
			blockers: [
				"Need decision on action SHA pinning versus current tag form.",
				"Need CI runner result for coverage-security workflow.",
			],
			readGlobs: [
				".forgejo/workflows/*.yaml",
				"templates/forgejo/*.yaml",
				"docker/coverage.Dockerfile",
				"scripts/security-scan.ts",
				"tests/unit/security-scan.test.ts",
				"tests/unit/coverage-security-yaml.test.ts",
			],
			writeGlobs: [
				".forgejo/workflows/coverage-security.yaml",
				"templates/forgejo/coverage-security.yaml",
				"docker/coverage.Dockerfile",
				"scripts/security-scan.ts",
				"tests/unit/security-scan.test.ts",
				"tests/unit/coverage-security-yaml.test.ts",
			],
			forbiddenGlobs: ["scripts/verify-release.ts"],
			commands: [
				{
					command:
						"bun test tests/unit/security-scan.test.ts tests/unit/coverage-security-yaml.test.ts",
					lane: "macos-native",
					mutatesSystem: false,
					requiredForAcceptance: true,
					expected: "Security and workflow structure tests pass.",
				},
				{
					command: "bun scripts/security-scan.ts",
					lane: "macos-native",
					mutatesSystem: false,
					requiredForAcceptance: true,
					expected:
						"Required security checks pass; optional missing scanners are explicit.",
				},
			],
			mcpAndApps: ["Linear read-only"],
			docs: [
				"GitHub Actions security hardening docs",
				"SLSA v1.2",
				"NIST SSDF SP 800-218",
				"OpenSSF Scorecard docs",
			],
			roles: [
				{
					name: "supply-chain-auditor",
					modelIntent: "opus-review",
					scope:
						"Challenge workflow trust boundary and supply-chain assumptions.",
					tools: ["Read", "rg", "web primary docs", "bun test"],
				},
			],
			optimizedPrompt:
				"Audit CI/security artifacts for CEL-464. Prioritize least privilege, untrusted PR boundaries, pinned external dependencies, fail-closed required checks, and honest optional scanner skips.",
			synchronization:
				"Can request changes from coverage/platform threads but owns only workflow/security files.",
		},
		{
			id: "qa-validation",
			issueIds: ["CEL-465"],
			status: "complete",
			scope:
				"Run final validation matrix, collect command results, and propose PR split after implementation slices settle.",
			dependencies: [
				"repo-coverage-review",
				"platform-orbstack-review",
				"ci-security-review",
			],
			inputs: [
				"all changed files",
				"Linear CEL-465 checklist",
				"local and CI command output",
			],
			outputs: [
				"validation transcript",
				"PR split recommendation",
				"residual risk list",
			],
			blockers: [
				"CI workflow run result is remote state and must be fetched live after PR publication before claiming merge-authoritative green.",
			],
			readGlobs: ["**/*"],
			writeGlobs: [],
			forbiddenGlobs: ["scripts/verify-release.ts"],
			commands: [
				{
					command: "bun test",
					lane: "macos-native",
					mutatesSystem: false,
					requiredForAcceptance: true,
					expected: "All Bun tests pass.",
				},
				{
					command:
						"bun scripts/verify-fast.ts && bun scripts/verify-commit.ts && bun scripts/verify-pr.ts",
					lane: "macos-native",
					mutatesSystem: false,
					requiredForAcceptance: true,
					expected:
						"Tier gates pass or report known Darwin fuzz degradation honestly.",
				},
				{
					command: "bun scripts/coverage-docker.ts --fail-under-lines 95",
					lane: "ci-linux",
					mutatesSystem: true,
					requiredForAcceptance: true,
					expected:
						"Docker/Fedora kcov lane reports measured coverage at or above threshold.",
				},
			],
			mcpAndApps: ["Linear read-only", "GitHub/Forgejo read-only"],
			docs: [
				"CEL-465 Linear issue",
				"doc/adr/0007-platform-coverage-security-workflow.md",
			],
			roles: [
				{
					name: "validation-runner",
					modelIntent: "sonnet-implementation",
					scope: "Run approved local validations and summarize exact results.",
					tools: ["bun test", "bun scripts/verify-*", "git status"],
				},
				{
					name: "review-splitter",
					modelIntent: "opus-review",
					scope: "Split residual work into reviewable PR slices.",
					tools: ["git diff", "gh pr status", "Linear read"],
				},
			],
			optimizedPrompt:
				"Execute CEL-465 validation after all implementation threads are complete. Keep local, OrbStack, CI, and remote evidence separate. Do not claim green for lanes not run.",
			synchronization:
				"Consumes all previous thread outputs; does not edit implementation unless a validation failure has a narrow approved fix.",
		},
		{
			id: "live-report",
			issueIds: ["CEL-461", "CEL-464", "CEL-465"],
			status: "blocked",
			scope:
				"Publish the final interactive live report to the Phoenix LiveView report host slug.",
			dependencies: ["qa-validation"],
			inputs: [
				"workflow file",
				"validation transcript",
				"findings",
				"blockers",
			],
			outputs: ["https://report.cordillera.home/r/cel-461-kcov-status"],
			blockers: [
				"Report-host publication is a remote/durable write and needs explicit approval in this thread.",
			],
			readGlobs: [
				"report-platform/**",
				"doc/adr/0006-report-platform.md",
				".agents/workflows/cel-461-kcov-status.workflow.ts",
			],
			writeGlobs: ["report-platform/**"],
			forbiddenGlobs: ["scripts/verify-release.ts"],
			commands: [
				{
					command:
						"REPORT_HOST_REPORT_PATH=<approved-path> bun report-platform/publish.ts",
					lane: "report-host",
					mutatesSystem: true,
					requiredForAcceptance: true,
					expected:
						"Publishes report only after approval and reports final URL.",
				},
			],
			mcpAndApps: [],
			docs: ["doc/adr/0006-report-platform.md", "report-platform/README.md"],
			roles: [
				{
					name: "report-publisher",
					modelIntent: "sonnet-implementation",
					scope:
						"Prepare report content and publish only after explicit approval.",
					tools: ["Read", "bun report-platform/publish.ts"],
				},
			],
			optimizedPrompt:
				"Prepare a concise report-host payload for cel-461-kcov-status with status, findings, validations, blockers, next safe step, and approval-gated operations. Do not publish without explicit approval.",
			synchronization:
				"Final consumer of all thread evidence; no implementation ownership.",
		},
	],
	qaCycles: [
		"Cycle 1: structural review of typed workflow, repo inventory, and Linear states.",
		"Cycle 2: unit tests for coverage, OrbStack, platform, workflow YAML, and security scan.",
		"Cycle 3: local macOS gates with Darwin degradation kept distinct from Linux evidence.",
		"Cycle 4: OrbStack and Docker Linux measured coverage run.",
		"Cycle 5: CI/remote workflow result fetch after PR publication.",
	],
	acceptanceCriteria: [
		"Workflow file validates unique thread IDs, existing dependencies, and non-overlapping write ownership.",
		"CEL-461 status distinguishes completed local validation from pending CI merge authority.",
		"src/lib.zig remains included in coverage targets.",
		"Missing kcov is a blocker or explicit advisory skip, never coverage evidence.",
		"macOS native, OrbStack Linux, and CI Linux results are reported separately.",
		"Concurrent scripts/verify-release.ts edits are preserved unless explicitly approved.",
	],
	iterativeImprovement: [
		"After each research thread, append findings to this workflow or a follow-up workflow revision before changing implementation.",
		"If a validation command fails, add a narrow issue note with exact command, output summary, owner thread, and proposed file scope.",
		"If external docs conflict with current implementation, prefer primary docs and encode the decision in ADR or skill reference before code changes.",
	],
	explicitApprovalRequiredFor: [
		"Editing scripts/verify-release.ts",
		"Running orb create or provisioning OrbStack machines",
		"Running Docker build/run coverage lanes if resource impact matters",
		"Publishing to report.cordillera.home",
		"Writing Linear comments/documents",
		"Pushing branches or opening PRs",
	],
} as const satisfies WorkflowProgram;

function assertWorkflow(program: WorkflowProgram): void {
	const threadIds = new Set<ThreadId>();
	for (const thread of program.threads) {
		if (threadIds.has(thread.id)) {
			throw new Error(`duplicate thread id: ${thread.id}`);
		}
		threadIds.add(thread.id);
	}

	for (const thread of program.threads) {
		for (const dep of thread.dependencies) {
			if (!threadIds.has(dep)) {
				throw new Error(`${thread.id} depends on unknown thread ${dep}`);
			}
		}
	}
	assertAcyclicThreads(program);

	const ownedGlobs: Array<{ thread: ThreadId; glob: string }> = [];
	for (const thread of program.threads) {
		for (const glob of thread.writeGlobs) {
			for (const owner of ownedGlobs) {
				if (owner.thread !== thread.id && globsMayOverlap(owner.glob, glob)) {
					throw new Error(
						`write ownership conflict: ${owner.thread} owns ${owner.glob}, ${thread.id} owns ${glob}`,
					);
				}
			}
			ownedGlobs.push({ thread: thread.id, glob });
		}
		for (const forbidden of thread.forbiddenGlobs) {
			if (thread.writeGlobs.includes(forbidden)) {
				throw new Error(`${thread.id} both owns and forbids ${forbidden}`);
			}
		}
	}

	const approvalTargets = program.safetyGates
		.filter((gate) => gate.confirmationRequired)
		.flatMap((gate) => gate.appliesTo);
	if (approvalTargets.length === 0) {
		throw new Error("workflow has no approval-gated targets");
	}
}

function globPrefix(glob: string): string {
	const wildcard = glob.search(/[*?[{]/);
	const prefix = wildcard === -1 ? glob : glob.slice(0, wildcard);
	return prefix.replace(/\/+$/, "");
}

function globsMayOverlap(left: string, right: string): boolean {
	if (left === right || left === "**/*" || right === "**/*") return true;
	if (globMatches(left, right) || globMatches(right, left)) return true;
	const leftSample = globSample(left);
	const rightSample = globSample(right);
	if (globMatches(left, rightSample) || globMatches(right, leftSample))
		return true;
	const leftPrefix = globPrefix(left);
	const rightPrefix = globPrefix(right);
	if (leftPrefix.length === 0 || rightPrefix.length === 0) return true;
	return (
		leftPrefix.startsWith(`${rightPrefix}/`) ||
		rightPrefix.startsWith(`${leftPrefix}/`) ||
		leftPrefix === rightPrefix
	);
}

function escapeRegExp(value: string): string {
	return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function globToRegExp(glob: string): RegExp {
	let source = "^";
	for (let i = 0; i < glob.length; i++) {
		const char = glob[i];
		if (char === "*") {
			if (glob[i + 1] === "*") {
				source += ".*";
				i++;
			} else {
				source += "[^/]*";
			}
		} else if (char === "?") {
			source += "[^/]";
		} else {
			source += escapeRegExp(char);
		}
	}
	return new RegExp(`${source}$`);
}

function globMatches(pattern: string, path: string): boolean {
	return globToRegExp(pattern).test(path);
}

function globSample(glob: string): string {
	return glob
		.replace(/\*\*/g, "dir")
		.replace(/\*/g, "sample")
		.replace(/\?/g, "x");
}

function assertAcyclicThreads(program: WorkflowProgram): void {
	const byId = new Map(program.threads.map((thread) => [thread.id, thread]));
	const visiting = new Set<ThreadId>();
	const visited = new Set<ThreadId>();

	const visit = (id: ThreadId, path: ThreadId[]): void => {
		if (visited.has(id)) return;
		if (visiting.has(id)) {
			throw new Error(`thread dependency cycle: ${[...path, id].join(" -> ")}`);
		}
		visiting.add(id);
		const thread = byId.get(id);
		if (!thread) throw new Error(`unknown thread ${id}`);
		for (const dep of thread.dependencies) visit(dep, [...path, id]);
		visiting.delete(id);
		visited.add(id);
	};

	for (const thread of program.threads) visit(thread.id, []);
}

assertWorkflow(workflow);

export { workflow };

if (import.meta.main) {
	console.log(
		JSON.stringify(
			{
				slug: workflow.slug,
				status: workflow.statusAnswer,
				reportUrl: workflow.reportUrl,
				threadCount: workflow.threads.length,
				blockedThreads: workflow.threads
					.filter((thread) => thread.status === "blocked")
					.map((thread) => thread.id),
			},
			null,
			2,
		),
	);
}
