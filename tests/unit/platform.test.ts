import { describe, expect, test } from "bun:test";
import {
	detectPlatform,
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

	test("detects OrbStack marker aliases", () => {
		for (const env of [
			{ ORBSTACK: "true" },
			{ ORB_STACK_MACHINE: "zig-qm" },
			{ ZIG_QM_ORBSTACK_MACHINE: "zig-qm" },
		]) {
			expect(detectPlatformLane({ platform: "linux", env })).toBe(
				"orbstack-linux",
			);
		}
	});

	test("CI wins over OrbStack markers", () => {
		const facts = platformFacts({
			platform: "linux",
			env: { CI: "true", ORBSTACK: "true" },
		});
		expect(facts.lane).toBe("ci-linux");
		expect(facts.ci).toBe(true);
		expect(facts.orbstack).toBe(false);
	});

	test("classifies linux-local and other lanes", () => {
		const linux = platformFacts({ platform: "linux", env: {} });
		expect(linux.lane).toBe("linux-local");
		expect(linux.fuzzAuthority).toBe(false);
		expect(linux.coverageAuthority).toBe(false);
		expect(linux.securityAuthority).toBe(false);

		const other = platformFacts({ platform: "freebsd", env: {} });
		expect(other.lane).toBe("other");
		expect(other.fuzzAuthority).toBe(false);
	});

	test("explicit ci-linux override keeps ci facts coherent", () => {
		expect(
			detectPlatform({
				platform: "darwin",
				env: { ZIG_QM_PLATFORM_LANE: "ci-linux" },
			}),
		).toEqual({ lane: "ci-linux", ci: true, orbstack: false });
		const facts = platformFacts({
			platform: "darwin",
			env: { ZIG_QM_PLATFORM_LANE: "ci-linux" },
		});
		expect(facts.lane).toBe("ci-linux");
		expect(facts.ci).toBe(true);
		expect(facts.coverageAuthority).toBe(true);
	});
});
