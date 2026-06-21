/**
 * Tests for the per-release hardening validators (Phases 2-4):
 *   - validateSbom        (Phase 4): CycloneDX structural + dep-coverage check
 *   - signingEnvError     (Phase 2): pre-flight signing-environment validation
 *   - signingVerifyArgs   (Phase 3): cosign verify-blob argv (key / keyless)
 *
 * All three are pure functions (env injected), so they are verified here
 * without a real cosign binary or build.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	declaredDepNames,
	signingEnvError,
	signingVerifyArgs,
	validateSbom,
} from "../../scripts/verify-release.ts";

const minimalSbom = (extra = {}) =>
	JSON.stringify({
		bomFormat: "CycloneDX",
		specVersion: "1.5",
		components: [{ name: "ziglint" }],
		...extra,
	});

// ---- Phase 4: validateSbom -------------------------------------------------

test("validateSbom accepts a well-formed CycloneDX doc", () => {
	const r = validateSbom(minimalSbom());
	expect(r.ok).toBe(true);
	expect(r.specVersion).toBe("1.5");
	expect(r.componentCount).toBe(1);
	expect(r.errors).toEqual([]);
});

test("validateSbom rejects non-JSON", () => {
	const r = validateSbom("{ not json");
	expect(r.ok).toBe(false);
	expect(r.errors[0]).toMatch(/not valid JSON/);
});

test("validateSbom rejects wrong bomFormat / missing specVersion / non-array components", () => {
	const r = validateSbom(
		JSON.stringify({ bomFormat: "SPDX", components: {} }),
	);
	expect(r.ok).toBe(false);
	expect(r.errors.some((e) => /bomFormat/.test(e))).toBe(true);
	expect(r.errors.some((e) => /specVersion/.test(e))).toBe(true);
	expect(r.errors.some((e) => /components is not an array/.test(e))).toBe(true);
});

test("validateSbom flags a declared dependency missing from components", () => {
	const r = validateSbom(minimalSbom(), ["ziglint", "missingdep"]);
	expect(r.ok).toBe(false);
	expect(r.errors.some((e) => /missingdep/.test(e))).toBe(true);
	// the present one must NOT be flagged
	expect(r.errors.some((e) => /"ziglint"/.test(e))).toBe(false);
});

test("validateSbom passes when all declared deps are covered", () => {
	const r = validateSbom(minimalSbom(), ["ziglint"]);
	expect(r.ok).toBe(true);
});

// ---- Phase 2: signingEnvError ---------------------------------------------

test("signingEnvError: missing binary is an error", () => {
	expect(signingEnvError(null, { COSIGN_KEY: "cosign.key" })).toMatch(
		/binary not found/,
	);
});

test("signingEnvError: no credentials is an error", () => {
	const e = signingEnvError("/usr/bin/cosign", {});
	expect(e).toMatch(/no signing credentials/);
});

test("signingEnvError: key-based is OK", () => {
	expect(signingEnvError("/usr/bin/cosign", { COSIGN_KEY: "k.key" })).toBeNull();
});

test("signingEnvError: keyless (experimental / OIDC / CI token) is OK", () => {
	expect(signingEnvError("/usr/bin/cosign", { COSIGN_EXPERIMENTAL: "1" })).toBeNull();
	expect(
		signingEnvError("/usr/bin/cosign", { COSIGN_OIDC_ISSUER: "https://x" }),
	).toBeNull();
	expect(
		signingEnvError("/usr/bin/cosign", {
			ACTIONS_ID_TOKEN_REQUEST_URL: "https://token",
		}),
	).toBeNull();
});

// ---- Phase 3: signingVerifyArgs -------------------------------------------

test("signingVerifyArgs: key-based uses --key", () => {
	const args = signingVerifyArgs("bin/app", "bin/app.sig", {
		COSIGN_KEY: "k.key",
	});
	expect(args).not.toBeNull();
	expect(args).toContain("--key");
	expect(args).toContain("k.key");
	expect(args?.[0]).toBe("verify-blob");
	expect(args?.at(-1)).toBe("bin/app");
});

test("signingVerifyArgs: COSIGN_PUBLIC_KEY takes precedence for verify", () => {
	const args = signingVerifyArgs("bin/app", "bin/app.sig", {
		COSIGN_PUBLIC_KEY: "pub.pem",
		COSIGN_KEY: "priv.key",
	});
	expect(args).toContain("pub.pem");
	expect(args).not.toContain("priv.key");
});

test("signingVerifyArgs: keyless uses certificate identity + issuer", () => {
	const args = signingVerifyArgs("bin/app", "bin/app.sig", {
		COSIGN_CERTIFICATE_IDENTITY: "ci@x",
		COSIGN_CERTIFICATE_OIDC_ISSUER: "https://issuer",
	});
	expect(args).toContain("--certificate-identity");
	expect(args).toContain("ci@x");
	expect(args).toContain("--certificate-oidc-issuer");
	expect(args).toContain("https://issuer");
});

test("signingVerifyArgs: returns null when keyless verify inputs are absent", () => {
	expect(signingVerifyArgs("bin/app", "bin/app.sig", {})).toBeNull();
});

// ---- declaredDepNames (Phase 4 SBOM dep-coverage source) -------------------

describe("declaredDepNames", () => {
	let dir = "";
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "zon-deps-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	const writeZon = (body: string) => writeFile(join(dir, "build.zig.zon"), body);

	test("returns [] when build.zig.zon is absent", async () => {
		expect(await declaredDepNames(dir)).toEqual([]);
	});

	test("returns [] when there is no .dependencies block", async () => {
		await writeZon(`.{ .name = .foo, .version = "0.0.0" }`);
		expect(await declaredDepNames(dir)).toEqual([]);
	});

	test("captures only TOP-LEVEL dependency keys, not nested struct keys", async () => {
		// `ziglint` and `other` are real deps; the nested `.foo`/`.bar` inside a
		// dependency's own struct must NOT be captured (the depth-blind bug).
		await writeZon(`.{
  .name = .czq,
  .version = "0.1.0",
  .dependencies = .{
    .ziglint = .{
      .url = "git+https://example/x.git#abc",
      .hash = "ziglint-0.0.0-aaaa",
      .lazy = .{ .foo = .{ .bar = .{} } },
    },
    .other = .{
      .path = "vendor/other",
    },
  },
  .paths = .{""},
}`);
		expect(await declaredDepNames(dir)).toEqual(["other", "ziglint"]);
	});

	test("captures quoted dependency names .@\"a-b\"", async () => {
		await writeZon(`.{
  .dependencies = .{
    .@"foo-bar" = .{ .path = "x" },
    .baz = .{ .path = "y" },
  },
}`);
		expect(await declaredDepNames(dir)).toEqual(["baz", "foo-bar"]);
	});

	test("empty .dependencies block yields []", async () => {
		await writeZon(`.{ .dependencies = .{}, }`);
		expect(await declaredDepNames(dir)).toEqual([]);
	});
});
