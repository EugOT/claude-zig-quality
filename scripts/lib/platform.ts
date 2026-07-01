export type PlatformLane =
	| "macos-native"
	| "orbstack-linux"
	| "ci-linux"
	| "linux-local"
	| "other";

export type PlatformFacts = {
	lane: PlatformLane;
	platform: string;
	ci: boolean;
	orbstack: boolean;
	fuzzAuthority: boolean;
	coverageAuthority: boolean;
	securityAuthority: boolean;
	notes: string[];
};

export type PlatformDetectOptions = {
	platform?: string;
	env?: Record<string, string | undefined>;
};

export type PlatformDetection = {
	lane: PlatformLane;
	ci: boolean;
	orbstack: boolean;
};

function truthyEnv(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function normalizePlatformLane(
	raw: string | undefined,
): PlatformLane | null {
	if (!raw) return null;
	switch (raw.trim()) {
		case "macos-native":
		case "orbstack-linux":
		case "ci-linux":
		case "linux-local":
		case "other":
			return raw.trim() as PlatformLane;
		default:
			throw new Error(
				`invalid ZIG_QM_PLATFORM_LANE=${JSON.stringify(raw)}; expected macos-native, orbstack-linux, ci-linux, linux-local, or other`,
			);
	}
}

export function detectPlatform(
	opts: PlatformDetectOptions = {},
): PlatformDetection {
	const env = opts.env ?? process.env;
	const override = normalizePlatformLane(env.ZIG_QM_PLATFORM_LANE);
	const platform = opts.platform ?? process.platform;
	const ci = truthyEnv(env.CI);
	const orbstack =
		truthyEnv(env.ORBSTACK) ||
		!!env.ORBSTACK_MACHINE ||
		!!env.ORB_STACK_MACHINE ||
		!!env.ZIG_QM_ORBSTACK_MACHINE;

	if (override) {
		return {
			lane: override,
			ci: ci || override === "ci-linux",
			orbstack: override === "orbstack-linux",
		};
	}

	if (platform === "darwin")
		return { lane: "macos-native", ci, orbstack: false };
	if (platform === "linux" && ci) {
		return { lane: "ci-linux", ci: true, orbstack: false };
	}
	if (platform === "linux" && orbstack) {
		return { lane: "orbstack-linux", ci, orbstack: true };
	}
	if (platform === "linux") return { lane: "linux-local", ci, orbstack: false };
	return { lane: "other", ci, orbstack: false };
}

export function detectPlatformLane(
	opts: PlatformDetectOptions = {},
): PlatformLane {
	return detectPlatform(opts).lane;
}

export function platformFacts(opts: PlatformDetectOptions = {}): PlatformFacts {
	const env = opts.env ?? process.env;
	const platform = opts.platform ?? process.platform;
	const detection = detectPlatform({ env, platform });
	const { lane, ci, orbstack } = detection;
	const linuxAuthority = lane === "orbstack-linux" || lane === "ci-linux";
	const notes: string[] = [];

	if (lane === "macos-native") {
		notes.push(
			"macOS native is the fast developer lane; Darwin Zig 0.16 fuzz degrades explicitly.",
		);
	} else if (lane === "orbstack-linux") {
		notes.push(
			"OrbStack Linux is the local Linux authority for fuzz and coverage before PR.",
		);
	} else if (lane === "ci-linux") {
		notes.push(
			"CI Linux is the merge authority for coverage and security gates.",
		);
	}

	return {
		lane,
		platform,
		ci,
		orbstack,
		fuzzAuthority: linuxAuthority,
		coverageAuthority: linuxAuthority,
		securityAuthority: lane === "ci-linux",
		notes,
	};
}
