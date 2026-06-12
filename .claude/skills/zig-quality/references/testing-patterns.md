# Zig 0.16 Testing Patterns

Zig test blocks + `std.testing.allocator` give leak detection as a
baseline, for free. Build the rest of the quality pyramid on that
foundation. For allocator-owned rules referenced here, see
`allocator-discipline.md`. For `Io` in tests, see `io-injection.md`.

## The baseline

```zig
test "parse handles empty input" {
    const result = try parse(std.testing.allocator, "");
    defer result.deinit(std.testing.allocator);
    try std.testing.expectEqual(@as(usize, 0), result.len);
}
```

- `std.testing.allocator` is a `DebugAllocator` wired to
  `testing.expect`.
- Any unfreed allocation at test exit → test fails automatically.
- No per-test cleanup code needed. Just `defer`.

## The expect family

| Assertion | Use |
|---|---|
| `expectEqual(a, b)` | Scalar equality (casts `comptime_int` for you) |
| `expectEqualSlices(T, a, b)` | Slice content equality, preserves element type |
| `expectEqualStrings(a, b)` | String equality with nicer diff output than slices |
| `expectError(err, expr)` | Expression must return exactly `err` |
| `expectApproxEqAbs(a, b, tol)` | Float abs tolerance |
| `expectApproxEqRel(a, b, tol)` | Float relative tolerance |
| `expect(cond)` | Bool assertion (prefer `expectEqual` for clearer failure) |

## Failing allocator — testing OOM paths

```zig
test "parse tolerates OOM gracefully" {
    try std.testing.expectError(
        error.OutOfMemory,
        parse(std.testing.failing_allocator, "big input"),
    );
}
```

`failing_allocator` always returns `OutOfMemory`. Pair with an
`errdefer` audit to confirm the code does not leak on the OOM path.

## Bounded buffers — testing memory budgets

```zig
test "compact-mode fits in 16 KiB" {
    var buf: [16 * 1024]u8 = undefined;
    var fba = std.heap.FixedBufferAllocator.init(&buf);
    _ = try parse(fba.allocator(), input);  // fails if it exceeds budget
}
```

Useful for library code claiming a max memory footprint — makes the
claim enforceable.

## Per-test timeouts (new in 0.16)

```
zig build test --test-timeout 30000
```

30-second real-time kill-and-restart per test. Catches tests that hang
on deadlocks or pathological scheduling. Put it in CI; keep
`--test-timeout 60000` as the default locally.

## Property-style testing (via fuzz primitives)

Zig has no QuickCheck yet. Use the integrated fuzzer's
`std.testing.Smith` generators inline.

```zig
test "fuzz: parse is lossless" {
    try std.testing.fuzz(fuzzParseRoundtrip, .{});
}

fn fuzzParseRoundtrip(input: []const u8) !void {
    const gpa = std.testing.allocator;
    const a = parse(gpa, input) catch return;  // OK to reject malformed
    defer a.deinit(gpa);
    const printed = try a.print(gpa);
    defer gpa.free(printed);
    const b = try parse(gpa, printed);
    defer b.deinit(gpa);
    try expectAstEqual(a, b);
}
```

`std.testing.Smith` offers `value`, `eos`, `bytes`, `slice`,
`valueRangeAtMost`, with hashed/weighted variants.

## Snapshot / golden testing

Commit expected output to `testdata/`, byte-compare:

```zig
test "snapshot: render(sample) matches golden" {
    const expected = @embedFile("testdata/sample.golden.txt");
    const actual = try render(std.testing.allocator, sample_input);
    defer std.testing.allocator.free(actual);
    try std.testing.expectEqualStrings(expected, actual);
}
```

Policy: intentional golden-file changes ship **in the same commit that
regenerates them**, with a rationale in the commit message. Never
"just update the golden" without explaining why.

## Differential testing (oracle pattern)

If a reference implementation exists (zstd, sqlite, standard parsers),
diff-test against it.

```zig
test "diff: our parser matches reference-json" {
    for (0..1024) |_| {
        var smith = someSeededSmith();
        const doc = smith.json();
        const ours = parseOurs(gpa, doc) catch continue;
        defer ours.deinit(gpa);
        const theirs = parseReference(gpa, doc) catch |e| {
            // if the reference rejects, so must we
            try std.testing.expectError(e, parseOurs(gpa, doc));
            continue;
        };
        defer theirs.deinit(gpa);
        try expectEqual(ours, theirs);
    }
}
```

## Structure

```
src/
  parse.zig
  render.zig
tests/
  test_parse.zig
  test_render.zig
  testdata/
    sample.input
    sample.golden.txt
```

In `build.zig`:

```zig
const tests = b.addTest(.{ .root_source_file = b.path("tests/all.zig") });
tests.root_module.addImport("myproj", main_mod);
const run_tests = b.addRunArtifact(tests);
const test_step = b.step("test", "Run all tests");
test_step.dependOn(&run_tests.step);
```

Where `tests/all.zig` is
`_ = @import("test_parse.zig"); _ = @import("test_render.zig");`.

## Rules

- Every `pub fn` has ≥ 1 test.
- Every `pub fn parse*` / `decode*` has a fuzz target.
- Every public allocator-returning fn has an OOM test using
  `failing_allocator`.
- Every public error variant has a test that exercises it via
  `expectError`.
- Snapshot files live in `tests/testdata/` under version control.

## Anti-patterns

- `try std.testing.expect(a == b)` — use `expectEqual` for better diff
  output.
- `try std.testing.expect(!ok)` — assertion without message; write
  what you expected.
- `std.testing.allocator` + manual `deinit()` inside the test body
  instead of `defer` — brittle.
- Skipping a test via `return error.SkipZigTest` without an
  explanatory comment.

## Run targeted subsets

```
zig build test --test-filter "parse"
zig build test --summary failures
zig build test -ODebug
zig build test -OReleaseSafe
zig build test -OReleaseFast -fsanitize=thread
```

Rotate safety modes in CI. Each surfaces different UB.
