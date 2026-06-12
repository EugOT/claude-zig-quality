---
name: zig-build-system
description: Use when editing build.zig or build.zig.zon, declaring Zig 0.16 dependencies, setting up cross-target builds, or adding lint/fuzz/test steps. Covers mandatory fingerprint, project-local zig-pkg cache, --fork override, b.addTranslateC.
user-invocable: false
allowed-tools: Read, Grep, Bash(zig build:*), Bash(zig fetch:*)
---

# Zig 0.16 Build System

`build.zig` is the authoritative orchestration source. Package graph, C
translation, cross-compile matrix, temp files, lint/fuzz/test, and
incremental watch all flow through it. Treat it as first-class source, not a
script. Do not shell around it.

## `build.zig.zon` — what 0.16 requires

```zig
.{
    .name = .myproj,
    .version = "0.1.0",
    .fingerprint = 0x12345abcdef,        // REQUIRED in 0.16; build fails without it
    .minimum_zig_version = "0.16.0",
    .paths = .{ "build.zig", "build.zig.zon", "src" },
    .dependencies = .{
        .somepkg = .{
            .url = "https://github.com/...",
            .hash = "12209d...",           // modern hash; legacy format removed
        },
    },
}
```

- `fingerprint` is a per-project unique u64 (`zig init` picks one).
- Dependencies extract to **project-local** `zig-pkg/<hash>/` next to
  `build.zig` on first use; compressed `$HASH.tar.gz` stays in the global cache.
- Legacy hash format is gone.
- Never commit `zig-pkg/` or `.zig-cache/`.

## Dependency overrides

```
zig build --fork=../some-dep-fork
```

Ephemeral override by package name+fingerprint across the whole tree. Use
for ecosystem repair, clear before declaring a branch releasable, and log
any use in the commit message.

## build.zig skeleton (0.16)

```zig
const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const root_mod = b.createModule(.{
        .root_source_file = b.path("src/lib.zig"),
        .target = target,
        .optimize = optimize,
    });

    const exe = b.addExecutable(.{
        .name = "myproj",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
            .imports = &.{.{ .name = "myproj", .module = root_mod }},
        }),
    });
    b.installArtifact(exe);

    const tests = b.addTest(.{ .root_module = root_mod });
    const run_tests = b.addRunArtifact(tests);
    run_tests.addArgs(&.{ "--test-timeout", "30s" });
    b.step("test", "Run tests").dependOn(&run_tests.step);

    const fuzz_tests = b.addTest(.{ .root_module = root_mod });
    const run_fuzz = b.addRunArtifact(fuzz_tests);
    run_fuzz.addArgs(&.{ "--fuzz", "-j", "4" });
    b.step("fuzz", "Run fuzz tests").dependOn(&run_fuzz.step);

    const fmt = b.addFmt(.{ .paths = &.{ "src", "build.zig" }, .check = true });
    b.step("fmt", "Check formatting").dependOn(&fmt.step);
}
```

## C interop: `@cImport` → `b.addTranslateC`

Source-level `@cImport` is deprecated in 0.16. Move to the build system:

```zig
const c_mod = b.addTranslateC(.{
    .root_source_file = b.path("src/c_bindings.h"),
    .target = target,
    .optimize = optimize,
});
root_mod.addImport("c", c_mod.createModule());
```

Benefits: caching via arocc + native translate-c, no libclang dep,
IDE-discoverable.

## Accessing `Io` in build.zig

`b.graph.io` is the project-wide `std.Io`. Use it to stat/open/walk the
build root (e.g., to collect `.zig` inputs for a lint step). Always open
iterable dirs with `.{ .iterate = true }` and `defer dir.close(io)`.

## CLI flags worth knowing (0.16)

| Flag | Effect |
|---|---|
| `--error-style={verbose,minimal,verbose_clear,minimal_clear}` | Output shaping; `minimal_clear` is great for agents |
| `--multiline-errors={indent,newline,none}` | Stack formatting |
| `--test-timeout <duration>` | Per-test kill-and-restart; requires units (`30s`) |
| `--test-filter TEXT` | Substring-match test names |
| `--fuzz` / `--fuzz=<iterations>` / `-jN` | Fuzz mode |
| `-freference-trace=10` | Deep error traces |
| `-fincremental --watch` | Incremental + watch (opt-in, dev only) |
| `--fork=<path>` | Temporary dep override |
| `-Dtarget=<triple>` | Cross-compile |
| `-Doptimize={Debug,ReleaseSafe,ReleaseFast,ReleaseSmall}` | Safety rotation |
| `--time-report` | Compile-time profiler |

## Cross-compile matrix (lint signal)

Broken cross-builds expose platform assumptions hidden in business logic.
Run on PR:

```
for t in x86_64-linux-musl aarch64-linux-gnu aarch64-macos \
         x86_64-windows-msvc wasm32-wasi; do
  zig build -Dtarget=$t || { echo "FAIL: $t"; exit 1; }
done
```

## Safety-mode rotation

- `-ODebug` per-commit (fast, max checks)
- `-OReleaseSafe` per-PR (checks on, different codegen)
- `-OReleaseFast -fsanitize=address` nightly (UB ReleaseSafe misses)
- `-OReleaseFast -fstrip` release

## ziglint

Use `github.com/EugOT/ziglint` as the authoritative linter fork (Zig 0.16).
Do not substitute `mattware`/`nektro` forks. It is one gate beside `zig
fmt`, `zig ast-check`, tests, fuzzing, and architecture fitness checks.

## Anti-patterns

- `@cImport` in `src/*.zig` (use `b.addTranslateC`).
- Hardcoding `-fllvm`; expose as `-Dllvm=true`.
- Shell-scripting around `zig build` — add steps.
- Writing temp files in `zig-cache/`; use `b.addTempFiles` / `b.tmpPath`.
- Committing `zig-pkg/` or `.zig-cache/`.

## Incremental dev loop

```
zig build -fincremental --watch --error-style=minimal_clear
```

Opt-in only; require clean non-incremental rebuild in CI.
