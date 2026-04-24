#!/usr/bin/env bun
/**
 * verify-release.ts — Tier 4 (hours).
 *
 * Pre-tag gate. Runs verify-pr first, then:
 *   1. Clean non-incremental rebuild
 *   2. Reproducibility check (two clean rebuilds, hash-compare zig-out/bin)
 *   3. Deep fuzz (FUZZ_BUDGET_SECONDS, default 7200 = 2h), only when
 *      `fuzz` step exists and the platform supports it. Budget-elapsed is
 *      treated as a pass ("fuzz budget elapsed; no crashes").
 *   4. SBOM via `zig run scripts/emit-sbom.zig`, falling back to `syft` if
 *      on PATH; otherwise a loud skip message pointing at the ADR.
 *   5. cosign signing — only when cosign is present AND COSIGN_ENABLED=1
 *      AND a CI environment is detected (CI=true). Otherwise logs a skip
 *      referencing doc/adr/0001 §0.12.
 *
 * Exit codes:
 *   0 — pass
 *   1 — real failure (build mismatch, fuzz crash, reproducibility drift)
 */
import { resolve } from "node:path";
import { zig, zigSupportsFuzz, zigFuzzSkipMessage } from "./lib/zig.ts";
import { spawnSync, repoRoot, tail, appendJsonl } from "./lib/runtime.ts";

const TIER = "release" as const;

function cpuCount(): number {
  const n =
    typeof navigator !== "undefined" && typeof navigator.hardwareConcurrency === "number"
      ? navigator.hardwareConcurrency
      : 0;
  return n > 0 ? n : 4;
}

async function finish(code: number, startedAt: number): Promise<never> {
  const durationMs = Date.now() - startedAt;
  await appendJsonl(".claude/logs/verify.jsonl", {
    event: "verify",
    tier: TIER,
    code,
    durationMs,
  });
  process.exit(code);
}

function hasBuildStep(step: string): boolean {
  const listing = zig(["build", "-l"]);
  const text = `${listing.stdout}\n${listing.stderr}`;
  const re = new RegExp(`^[\\s]+${step}[\\s]`, "m");
  return re.test(text);
}

function cleanArtifacts(root: string): void {
  spawnSync(["rm", "-rf", resolve(root, ".zig-cache"), resolve(root, "zig-out")]);
}

function hashZigOut(root: string): string {
  const bin = resolve(root, "zig-out", "bin");
  const glob = new Bun.Glob("*");
  const files: string[] = [];
  try {
    for (const f of glob.scanSync({ cwd: bin, absolute: true })) files.push(f);
  } catch {
    return "";
  }
  if (files.length === 0) return "";
  files.sort();
  // Hash each file independently, then hash the concatenated digests. This
  // is stable across runs because we sort by absolute path and the per-file
  // digest is content-addressed.
  const hasher = new Bun.CryptoHasher("sha256");
  for (const f of files) {
    const r = spawnSync(["shasum", "-a", "256", f]);
    if (r.code !== 0) return "";
    const first = r.stdout.split(/\s+/, 1)[0] ?? "";
    hasher.update(first);
  }
  return hasher.digest("hex");
}

async function runFuzzBounded(limit: string, budgetSeconds: number): Promise<"pass" | "timeout" | number> {
  const root = repoRoot();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetSeconds * 1000);
  const cmd = [
    "bun",
    "-e",
    "import { zig } from './scripts/lib/zig.ts';" +
      "const args = JSON.parse(process.argv[1] ?? '[]');" +
      "const r = zig(args);" +
      "process.stdout.write(r.stdout);" +
      "process.stderr.write(r.stderr);" +
      "process.exit(r.code ?? 1);",
    JSON.stringify([
      "build",
      "fuzz",
      "--summary",
      "failures",
      `--fuzz=${limit}`,
      `-j${cpuCount()}`,
    ]),
  ];
  const proc = Bun.spawn(cmd, {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "ignore",
    signal: controller.signal,
  });
  try {
    const code = await proc.exited;
    clearTimeout(timer);
    if (code === 0) return "pass";
    return code;
  } catch {
    clearTimeout(timer);
    return "timeout";
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const root = repoRoot();

  console.log("== verify-release -> verify-pr ==");
  const pr = Bun.spawnSync(["bun", "scripts/verify-pr.ts"], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "ignore",
  });
  if (pr.exitCode !== 0) await finish(pr.exitCode ?? 1, startedAt);

  console.log("== Clean non-incremental rebuild ==");
  cleanArtifacts(root);
  const build1 = zig(["build", "--summary", "all"]);
  process.stdout.write(build1.stdout);
  process.stderr.write(build1.stderr);
  if (build1.code !== 0) {
    console.error("verify-release: clean rebuild failed");
    console.error(tail(build1.stderr || build1.stdout));
    await finish(build1.code ?? 1, startedAt);
  }
  const h1 = hashZigOut(root);

  console.log("== Reproducibility check (second clean rebuild) ==");
  cleanArtifacts(root);
  const build2 = zig(["build", "--summary", "all"]);
  process.stdout.write(build2.stdout);
  process.stderr.write(build2.stderr);
  if (build2.code !== 0) {
    console.error("verify-release: second clean rebuild failed");
    await finish(build2.code ?? 1, startedAt);
  }
  const h2 = hashZigOut(root);

  if (h1.length === 0 && h2.length === 0) {
    console.log("(no zig-out/bin/* artifacts to hash — reproducibility check skipped)");
  } else if (h1 !== h2) {
    console.error("verify-release: rebuild produced different artifact hash");
    console.error(`  first:  ${h1}`);
    console.error(`  second: ${h2}`);
    await finish(1, startedAt);
  } else {
    console.log(`(reproducible: ${h1})`);
  }

  if (hasBuildStep("fuzz")) {
    if (zigSupportsFuzz()) {
      const limit = process.env.RELEASE_FUZZ_LIMIT ?? "1G";
      const budget = Number(process.env.FUZZ_BUDGET_SECONDS ?? "7200");
      console.log(`== Deep fuzz (${budget}s, --fuzz=${limit}) ==`);
      const verdict = await runFuzzBounded(limit, Number.isFinite(budget) && budget > 0 ? budget : 7200);
      if (verdict === "timeout") {
        console.log("(fuzz budget elapsed; no crashes)");
      } else if (verdict === "pass") {
        console.log("(fuzz completed within budget)");
      } else {
        console.error(`verify-release: fuzz crashed (exit ${verdict})`);
        await finish(verdict === 0 ? 1 : verdict, startedAt);
      }
    } else {
      console.log(zigFuzzSkipMessage());
    }
  } else {
    console.log("(no 'fuzz' build step — skipping fuzz gate)");
  }

  console.log("== SBOM (CycloneDX) ==");
  const sbomScript = resolve(root, "scripts/emit-sbom.zig");
  if (await Bun.file(sbomScript).exists()) {
    const sbom = zig(["run", "scripts/emit-sbom.zig", "--", "build.zig.zon"]);
    if (sbom.code === 0) {
      await Bun.write(resolve(root, "sbom.cdx.json"), sbom.stdout);
      console.log("(wrote sbom.cdx.json)");
    } else {
      console.error("verify-release: emit-sbom.zig failed");
      console.error(tail(sbom.stderr));
      await finish(sbom.code ?? 1, startedAt);
    }
  } else {
    const hasSyft = spawnSync(["command", "-v", "syft"]);
    if (hasSyft.code === 0) {
      const syft = spawnSync(["syft", "dir:.", "-o", "cyclonedx-json"]);
      if (syft.code === 0) {
        await Bun.write(resolve(root, "sbom.cdx.json"), syft.stdout);
        console.log("(wrote sbom.cdx.json via syft fallback)");
      } else {
        console.error("verify-release: syft fallback failed");
        await finish(syft.code ?? 1, startedAt);
      }
    } else {
      console.log("(no scripts/emit-sbom.zig and no syft on PATH — SBOM emission skipped)");
    }
  }

  console.log("== cosign sign artifacts ==");
  const hasCosign = spawnSync(["command", "-v", "cosign"]);
  const cosignEnabled = process.env.COSIGN_ENABLED === "1";
  const inCI = process.env.CI === "true" || process.env.CI === "1";
  if (hasCosign.code === 0 && cosignEnabled && inCI) {
    const bin = resolve(root, "zig-out", "bin");
    const glob = new Bun.Glob("*");
    for (const artifact of glob.scanSync({ cwd: bin, absolute: true })) {
      const sig = spawnSync(["cosign", "sign-blob", "--yes", artifact]);
      if (sig.code !== 0) {
        console.error(`verify-release: cosign sign-blob failed for ${artifact}`);
        await finish(sig.code ?? 1, startedAt);
      }
      await Bun.write(`${artifact}.sig`, sig.stdout);
      console.log(`(signed ${artifact})`);
    }
  } else {
    console.log("(cosign not configured; release signing skipped — see doc/adr/0001 + §0.12 release boundary)");
  }

  console.log("verify-release: OK");
  await finish(0, startedAt);
}

await main();
