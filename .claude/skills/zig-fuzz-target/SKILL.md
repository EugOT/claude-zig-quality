---
name: zig-fuzz-target
description: Use when writing a Zig 0.16 fuzz harness, adding fuzz steps to build.zig, designing Smith-based typed generators, or triaging a fuzzer crash. Covers std.testing.Smith generators, -j multiprocess mode, infinite mode with crash dumps, corpus persistence via FuzzInputOptions.corpus, and the differential-oracle pattern proven by squeek502/zig-std-lib-fuzzing.
user-invocable: false
allowed-tools: Read, Grep, Bash(zig build fuzz:*), Bash(zig build --fuzz*:*)
---

# Zig 0.16 Fuzz Targets

The integrated fuzzer is first-class in 0.16. `std.testing.Smith` replaced
raw byte slices with typed, weighted generators. Every parser, decoder,
deserializer, and state machine should have a fuzz target.

## Minimal fuzz target

```zig
test "fuzz: parse never crashes" {
    try std.testing.fuzz(fuzzOne, .{});
}

fn fuzzOne(input: []const u8) !void {
    const gpa = std.testing.allocator;
    const result = parse(gpa, input) catch return;  // rejecting malformed is fine
    defer result.deinit(gpa);
}
```

Run with `zig build test --fuzz`. The fuzzer persists crash inputs in
`zig-cache/` for replay.

## Typed generators (Smith)

```zig
fn fuzzRoundtrip(smith: *std.testing.Smith) !void {
    const gpa = std.testing.allocator;
    const kind = smith.valueWeighted(enum { int, string, array }, &.{ 5, 3, 2 });
    const payload = try smith.slice(u8, 0, 4096);
    const count = smith.valueRangeAtMost(u32, 100);

    const doc = try makeDoc(gpa, kind, payload, count);
    defer gpa.free(doc);
    const a = try parse(gpa, doc);        defer a.deinit(gpa);
    const printed = try a.print(gpa);     defer gpa.free(printed);
    const b = try parse(gpa, printed);    defer b.deinit(gpa);
    try expectAstEqual(a, b);
}
```

Smith API: `value(T)`, `valueWeighted(T, weights)`,
`valueRangeAtMost(T, max)`, `bytes(n)`, `slice(T, min, max)`, `eos`.

## build.zig fuzz step

```zig
const fuzz_tests = b.addTest(.{
    .root_source_file = b.path("tests/fuzz.zig"),
    .optimize = .Debug,
});
fuzz_tests.root_module.addImport("myproj", main_mod);
const run_fuzz = b.addRunArtifact(fuzz_tests);
run_fuzz.addArgs(&.{ "--fuzz", "-j", "4" });
b.step("fuzz", "Run fuzz tests").dependOn(&run_fuzz.step);
```

Per-subsystem targeting: `zig build fuzz -- <target>`.

## Differential-oracle pattern (highest leverage)

```zig
fn fuzzCompare(input: []const u8) !void {
    const ours = decodeOurs(gpa, input) catch null;
    defer if (ours) |d| gpa.free(d);
    const theirs = decodeReference(gpa, input) catch null;
    defer if (theirs) |d| gpa.free(d);
    try std.testing.expectEqual(ours == null, theirs == null);
    if (ours) |a| try std.testing.expectEqualSlices(u8, a, theirs.?);
}
```

Run our code and a reference on the same bytes. Any divergence is a bug
(usually ours). Proven on `squeek502/zig-std-lib-fuzzing`.

## Corpus persistence

```zig
try std.testing.fuzz(fuzzOne, .{
    .corpus = @embedFile("testdata/fuzz-corpus.bin"),
});
```

Policy: each crash-caught bug adds its minimized repro to the corpus;
regression becomes self-reinforcing.

## Multiprocess & infinite mode

- `-j N` — N worker processes sharing corpus.
- `--test-timeout 60s` — kill hangs.
- `--fuzz --infinite` — runs forever, coverage-prioritized. Nightly 8h, release 72h.

## What to fuzz

- Every `parse*` / `decode*` / `deserialize*`.
- Every serializer (roundtrip).
- Every state machine (no crash under any input sequence).
- Every public allocator-returning fn (no leaks, no UB).
- Every crypto primitive against a reference.

## What NOT to fuzz

- Pure functions with bounded input (exhaustive test fits).
- I/O functions — unit-test with `Io.failing`, integration-test with real paths.

## Triage

1. Reproduce from dump.
2. Shrink via built-in corpus minimization.
3. Add minimized input to `testdata/fuzz-corpus.bin`.
4. Write `test "regression: #NNN - brief description"` loading it.
5. Fix; confirm both the regression test and fresh fuzz run pass.

## AST/lint rules

- Every `pub fn parse*` / `decode*` / `deserialize*` → must have a matching fuzz target. Grep the fuzz file; fail if missing.
- Fuzz targets must `defer gpa.free(...)` on allocations.
- `catch unreachable` inside a fuzz handler → hard deny. Handlers return, not panic.

## Darwin note

On macOS with Zig `0.16.0`, native fuzz rebuilding is upstream-broken. The
runtime skip is explicit — not a silent pass. Linux CI is authoritative.
