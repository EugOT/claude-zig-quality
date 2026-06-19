//! claude-zig-quality — build graph.
//!
//! Mirrors the step shape of gitstore-cli so downstream quality tooling can
//! invoke a stable verb set:
//!   fmt | test | test-unit | test-lib | test-integration | fuzz | docs
//!
//! Cultural intent:
//!   - Library module at `src/lib.zig` is the public API surface scanned by
//!     scripts/zig-api-surface.zig and gated by .zig-qm/public-api.txt.
//!   - An alternate module `src/hello.zig` demonstrates that allocator
//!     discipline spans multiple files (arena vs. gpa).
//!   - Tests use std.testing.allocator so leaks fail the build.
//!   - Fuzz step depends on the full test graph so the `--fuzz` driver can
//!     enumerate fuzz-annotated tests (Zig 0.16 integrated Smith fuzzer).

const std = @import("std");
// Lint backend: the EugOT/ziglint fork (Zig 0.16). Pinned in build.zig.zon.
// ADOPTER OPT-OUT: a downstream project that does not want the lint gate can
// remove this import, the `lint` step below, and the `.ziglint` entry in
// build.zig.zon — the rest of the build graph has no dependency on it.
const ziglint = @import("ziglint");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    // -------------------------------------------------------------------- fmt
    const fmt = b.addFmt(.{
        .paths = &.{ "build.zig", "build.zig.zon", "src", "scripts" },
        .check = true,
    });
    const fmt_step = b.step("fmt", "Check formatting");
    fmt_step.dependOn(&fmt.step);

    // ---------------------------------------------------------- library module
    // Public library module: consumers depend on this and import it as
    // `@import("claude_zig_quality")`. This is also the module whose docs
    // we emit and whose public surface is diffed on every PR.
    const lib_mod = b.addModule("claude_zig_quality", .{
        .root_source_file = b.path("src/lib.zig"),
        .target = target,
        .optimize = optimize,
    });

    // Alternate surface: same public module root, but kept in a separate file
    // to show that allocator discipline is module-local, not global state.
    const hello_mod = b.createModule(.{
        .root_source_file = b.path("src/hello.zig"),
        .target = target,
        .optimize = optimize,
    });

    // -------------------------------------------------------- root executable
    // Optional "root" executable so `zig build` produces an installable
    // artifact and the build graph matches gitstore-cli shape.
    const exe_mod = b.createModule(.{
        .root_source_file = b.path("src/root.zig"),
        .target = target,
        .optimize = optimize,
    });

    const exe = b.addExecutable(.{
        .name = "claude-zig-quality",
        .root_module = exe_mod,
    });
    b.installArtifact(exe);

    const run_cmd = b.addRunArtifact(exe);
    run_cmd.step.dependOn(b.getInstallStep());
    if (b.args) |args| {
        run_cmd.addArgs(args);
    }
    const run_step = b.step("run", "Run the claude-zig-quality demo binary");
    run_step.dependOn(&run_cmd.step);

    // ---------------------------------------------------------------- tests
    // Unit tests: hello.zig (standalone, fast, arena-oriented)
    const unit_tests = b.addTest(.{ .root_module = hello_mod });
    const run_unit = b.addRunArtifact(unit_tests);

    // Public library smoke tests: exercises `@import("claude_zig_quality")`
    const lib_tests = b.addTest(.{ .root_module = lib_mod });
    const run_lib = b.addRunArtifact(lib_tests);

    // Integration tests: the root module wires library + hello together.
    const integration_tests = b.addTest(.{ .root_module = exe_mod });
    const run_integration = b.addRunArtifact(integration_tests);

    const test_step = b.step("test", "Run all tests");
    test_step.dependOn(&run_unit.step);
    test_step.dependOn(&run_lib.step);
    test_step.dependOn(&run_integration.step);

    const unit_step = b.step("test-unit", "Run unit tests only");
    unit_step.dependOn(&run_unit.step);

    const lib_step = b.step("test-lib", "Run public library smoke tests");
    lib_step.dependOn(&run_lib.step);

    const integration_step = b.step("test-integration", "Run integration/e2e tests");
    integration_step.dependOn(&run_integration.step);

    // -------------------------------------------------------- script-tool tests
    // The standalone AST tools under scripts/ carry their own unit tests
    // (zig-doc-coverage, zig-fitness, emit-sbom). They are not part of the
    // library module graph, so without an explicit step their tests never run
    // in CI. `test-scripts` compiles each as a test binary; it is folded into
    // the umbrella `test` step so `zig build test` covers them too.
    const script_tools: []const []const u8 = &.{
        "scripts/zig-doc-coverage.zig",
        "scripts/zig-fitness.zig",
        "scripts/emit-sbom.zig",
    };
    const scripts_step = b.step("test-scripts", "Run scripts/*.zig tool unit tests");
    for (script_tools) |tool_path| {
        const tool_mod = b.createModule(.{
            .root_source_file = b.path(tool_path),
            .target = target,
            .optimize = optimize,
        });
        const tool_test = b.addTest(.{ .root_module = tool_mod });
        const run_tool_test = b.addRunArtifact(tool_test);
        scripts_step.dependOn(&run_tool_test.step);
        test_step.dependOn(&run_tool_test.step);
    }

    // ----------------------------------------------------------------- fuzz
    // Fuzzing in Zig 0.16 is driven by the build runner's `--fuzz` flag.
    // This step prepares the full test graph so the runner can discover
    // project fuzz targets and rerun the relevant test binaries in fuzz mode.
    const fuzz_step = b.step("fuzz", "Prepare fuzz-capable test runs");
    fuzz_step.dependOn(&run_unit.step);
    fuzz_step.dependOn(&run_lib.step);
    fuzz_step.dependOn(&run_integration.step);

    // ----------------------------------------------------------------- docs
    const docs_install = b.addInstallDirectory(.{
        .source_dir = lib_tests.getEmittedDocs(),
        .install_dir = .prefix,
        .install_subdir = "docs",
    });
    const docs_step = b.step("docs", "Install generated API docs");
    docs_step.dependOn(&docs_install.step);

    // ----------------------------------------------------------------- lint
    // `zig build lint` runs the pinned EugOT/ziglint fork over src/ + build
    // descriptors. Kept OUT of `test_step` on purpose: per-turn verify-fast
    // stays sub-second (it uses a PATH `ziglint` if present), while the
    // per-commit and per-PR gates invoke `zig build lint` for authoritative,
    // PATH-independent enforcement. ziglint.addLint enforces exit 0, so any
    // finding fails this step.
    const lint_step = b.step("lint", "Run ziglint over sources and build files");
    const ziglint_dep = b.dependency("ziglint", .{ .optimize = .ReleaseFast });
    lint_step.dependOn(ziglint.addLint(
        b,
        ziglint_dep,
        &.{ b.path("src"), b.path("scripts"), b.path("build.zig") },
    ));
}
