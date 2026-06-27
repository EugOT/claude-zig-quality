import { describe, expect, test } from "bun:test";
import {
	detectPlatformLane,
	normalizePlatformLane,
	platformFacts,
} from "../../scripts/lib/platform.ts";

describe("platform lane detection", () => {
	test("explicit lane override wins", () => {
		expect(
			detectPlatformLane({
				platform: "darwin",
				env: { ZIG_QM_PLATFORM_LANE: "ci-linux" },
			}),
		).toBe("ci-linux");
	});

	test("rejects invalid explicit lane", () => {
		expect(() => normalizePlatformLane("linux-ci")).toThrow(
			/invalid ZIG_QM_PLATFORM_LANE/,
		);
	});

	test("darwin defaults to macos-native", () => {
		expect(detectPlatformLane({ platform: "darwin", env: {} })).toBe(
			"macos-native",
		);
	});

	test("linux CI is merge-authoritative", () => {
		const facts = platformFacts({ platform: "linux", env: { CI: "true" } });
		expect(facts.lane).toBe("ci-linux");
		expect(facts.fuzzAuthority).toBe(true);
		expect(facts.coverageAuthority).toBe(true);
		expect(facts.securityAuthority).toBe(true);
	});

	test("linux with OrbStack marker is local Linux authority", () => {
		const facts = platformFacts({
			platform: "linux",
			env: { ORBSTACK_MACHINE: "zig-qm-linux" },
		});
		expect(facts.lane).toBe("orbstack-linux");
		expect(facts.fuzzAuthority).toBe(true);
		expect(facts.coverageAuthority).toBe(true);
		expect(facts.securityAuthority).toBe(false);
	});
});
