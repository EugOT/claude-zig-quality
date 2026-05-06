# TIGER_STYLE_ZIG — Zig 0.16 quality discipline

This is the canonical style and discipline guide for Zig code in this
template. It is opinionated. The rules are enforced by the verifier,
the fixer, and the fitness engine; they are **not** suggestions.

The name echoes TigerStyle (TigerBeetle). The spirit is the same:
assertions as a first-class engineering tool, correctness before
performance, and refusal to let small risks accumulate silently.

## 1. Foundational rules

### 1.1 Always propagate allocators

Every function that allocates memory takes `alloc: std.mem.Allocator`
as an explicit parameter. No module-scoped `GeneralPurposeAllocator`,
no `DebugAllocator` hidden behind a getter, no silent fallback to
`std.heap.page_allocator`.

```zig
// WRONG
var gpa: std.heap.DebugAllocator(.{}) = .init;
pub fn buildBuffer(size: usize) ![]u8 {
    return gpa.allocator().alloc(u8, size);
}

// RIGHT
pub fn buildBuffer(alloc: std.mem.Allocator, size: usize) ![]u8 {
    return alloc.alloc(u8, size);
}
```

The caller decides the allocator. A library that hides its allocator
cannot be fuzzed, tested under
`std.testing.allocator`, or embedded in a larger system without
leaking memory or breaking determinism.

### 1.2 Name every public error set

`anyerror` is forbidden in any `pub` signature. Every public function
returns a named error set that lists exactly the errors a caller must
handle.

```zig
// WRONG
pub fn parseInt(text: []const u8) anyerror!i64 { ... }

// RIGHT
pub const ParseError = error{ InvalidCharacter, Overflow };
pub fn parseInt(text: []const u8) ParseError!i64 { ... }
```

`anyerror` in a `pub` return type defeats the compiler's error-set
inference across module boundaries and turns every upgrade into a
guessing game for callers. It is a semver hazard.

Within a module, inferred error sets (`!T` without a named set) are
allowed for private functions. The verifier flags only `pub` drift.

**Sanctioned exception — `pub fn main`.** The program entrypoint may
declare `pub fn main(...) !void`. Zig's runtime defines the contract
for `main`'s return type, so an inferred error set there is *not* a
semver hazard for callers (there are none). This is the only `pub`
position where `!T` without a named set is permitted; the verifier
whitelists `main` accordingly. See the §1.3 example.

### 1.3 Inject `std.Io` at the boundary

Public APIs that read or write streams accept `io: std.Io` (or the
narrower subset they need) as an explicit parameter. Direct use of
`std.io.getStdOut()` / `std.io.getStdIn()` inside a library is
forbidden.

```zig
// WRONG
pub fn greet(name: []const u8) !void {
    const stdout = std.io.getStdOut().writer();
    try stdout.print("hello, {s}\n", .{name});
}

// RIGHT
pub fn greet(writer: *std.Io.Writer, name: []const u8) std.Io.Writer.Error!void {
    try writer.print("hello, {s}\n", .{name});
}

// Top-level `main` wires the real stdout writer. The `io` argument is
// the program's `std.Io` instance, threaded in from `std.process.Init`
// (see §1.3 wiring elsewhere in this doc).
//
// `main`'s `!void` is the one place §1.2 permits an inferred error
// set on a `pub` signature: Zig's runtime defines the contract for
// `main`, so callers (there are none — the runtime invokes it)
// cannot drift on the inferred set.
pub fn main(init: std.process.Init) !void {
    const io = init.io;
    var buf: [128]u8 = undefined;
    var stdout = std.Io.File.stdout().writerStreaming(io, &buf);
    try greet(&stdout.interface, "world");
    try stdout.flush();
}
```

Only the program's top-level `main` (the "juicy main" idiom) wires a
real `std.Io` into the library. Everything below `main` is testable in
isolation.

### 1.4 Use the 0.16 idioms, not the 0.14/0.15 ones

| Old (0.14/0.15)                             | New (0.16)                                                 |
|---------------------------------------------|------------------------------------------------------------|
| `std.ArrayList(T).init(alloc)`              | `var list: std.ArrayList(T) = .empty;` + `append(alloc, x)` |
| `list.append(x)`                            | `list.append(alloc, x)`                                     |
| `std.heap.GeneralPurposeAllocator(.{}){}`   | `std.heap.DebugAllocator(.{})`                              |
| `std.mem.Allocator{}`                       | Always propagate, never construct                          |
| `fs.File.reader()`                          | `fs.File.deprecatedReader()` in transitional code          |
| `std.process.argsAlloc(alloc)`              | `std.process.argsAlloc(alloc)` (unchanged, `os.argv` gone) |
| `std.BoundedArray`                          | Removed in **0.15.1** (still gone in 0.16); roll your own  |
| `std.LinearFifo`                            | Removed in **0.15.1** (still gone in 0.16); use `std.fifo` |
| `b.addExecutable(.{ .root_source_file = f })` | `b.addExecutable(.{ .root_module = m })`                 |

The verifier rejects any `pub` signature or hot-path body that uses
the left column.

### 1.5 Parse, don't validate

Input at the system boundary is parsed into a typed value **once**.
The rest of the program operates on the typed value and never
re-parses. If a function returns `ParsedFoo`, no caller may accept a
raw string, validate it, and reconstruct the parsed value.

This is the Alexis King rule, ported to Zig. It eliminates an entire
class of bugs: `validate(foo) && use(foo)` races, parse-again-on-retry
inconsistencies, and the "how did we get here with this shape?"
debugging session.

### 1.6 Comptime refinement is first-class

Use `comptime` to reject bad states at compile time rather than at
runtime. A `comptime` precondition is worth ten runtime asserts.

```zig
pub fn Vec(comptime N: usize, comptime T: type) type {
    comptime {
        if (N == 0) @compileError("Vec length must be non-zero");
        if (@sizeOf(T) == 0) @compileError("Vec element size must be non-zero");
    }
    return struct { ... };
}
```

Prefer generic parameters over runtime enums when the set of valid
values is closed and small.

## 2. Assertion density

Every public entrypoint carries preconditions. Every invariant that
can be checked in `O(1)` or `O(log n)` is checked in `debug` builds.
Postconditions live at the return site.

Target: **≥ 2 asserts per 100 lines** of non-test code. The fitness
engine warns below 1 and fails below 0.5.

```zig
pub fn binarySearch(haystack: []const u32, needle: u32) ?usize {
    std.debug.assert(std.sort.isSorted(u32, haystack, {}, std.sort.asc(u32)));
    // ... body ...
    // postcondition: result in [0, haystack.len) if present
}
```

Asserts are documentation that the compiler and the tests both
enforce. `std.debug.assert` is stripped in release-fast; the cost is
paid only where it buys the most: during development and test.

## 3. `std.testing.allocator` is the default

Every test uses `std.testing.allocator`. This is non-negotiable. The
testing allocator catches leaks, double-frees, and use-after-free on
every test run, which is the cheapest integration test in existence.

```zig
test "parseInt rejects empty" {
    const alloc = std.testing.allocator;
    _ = alloc; // reserved; this test doesn't allocate
    try std.testing.expectError(ParseError.InvalidCharacter, parseInt(""));
}

test "ArrayList roundtrip" {
    const alloc = std.testing.allocator;
    var list: std.ArrayList(u32) = .empty;
    defer list.deinit(alloc);
    try list.append(alloc, 1);
    try list.append(alloc, 2);
    try std.testing.expectEqual(@as(usize, 2), list.items.len);
}
```

If a test does not allocate, mark `_ = alloc;` to document the
intentional non-use. The fitness engine flags tests that bypass
`std.testing.allocator` to hide leaks.

## 4. Snapshot tests in `testdata/`

Tests that compare structured output against an expected blob live in
`testdata/`. The comparison function reads the expected blob from
disk, and the update path is a single `ZIG_QM_UPDATE_SNAPSHOTS=1`
environment flag.

- File layout: `testdata/<module>/<test>.expected.txt`.
- Update path: `zig build test -Dupdate-snapshots` (wrapper script sets
  the env flag).
- Review rule: snapshot updates require a reviewer to open the diff
  and confirm the new output is semantically correct. Golden diffs
  are not rubber-stamp review material.

Why on disk? Inline expected strings inside `test "..."` blocks make
diffs of large output unreadable, and they discourage reuse across
test cases. Disk snapshots are the cheapest answer.

## 5. Error handling style

- Errors are values. Never silently swallow an error with `catch
  unreachable` unless a `comptime` proof exists that the error case
  cannot occur. Document the proof in a one-line comment above the
  `catch`.
- `errdefer` is preferred over try/catch cleanup chains. Let the
  compiler hoist the cleanup.
- `try` is the default. Explicit `catch` is reserved for actual
  handling, including mapping one error set to another (as required
  for public APIs that wrap private ones).

```zig
pub fn parseConfig(alloc: std.mem.Allocator, text: []const u8) ConfigError!Config {
    const parsed = std.json.parseFromSlice(RawConfig, alloc, text, .{}) catch |err| switch (err) {
        error.OutOfMemory => return ConfigError.OutOfMemory,
        else => return ConfigError.Invalid,
    };
    defer parsed.deinit();
    return Config.fromRaw(alloc, parsed.value);
}
```

## 6. Naming

- Types: `PascalCase`.
- Functions, variables, fields: `camelCase`.
- Constants: `SCREAMING_SNAKE_CASE` only for true compile-time
  constants at module scope. Local constants stay `camelCase`.
- Error set types: end with `Error` (e.g. `ParseError`, `ConfigError`).
- Private helpers: prefix with nothing; rely on Zig's visibility rules.
  Do not use `_` prefix unless explicitly marking "reserved" local
  bindings in test code.

## 7. Module shape

- Each public module has a `pub` declaration block at the top, ordered:
  types → constants → public functions → private helpers.
- One module = one concern. If `foo.zig` has two unrelated surfaces,
  split it.
- `src/root.zig` is the root build-unit module; `src/lib.zig` is the
  public API re-export surface. Consumers import `src/lib.zig`.
- Cross-module imports use `@import("...")`. Avoid deep-reaching into
  sibling modules' private helpers.

## 8. Build discipline

- `build.zig` uses the `b.addExecutable(.{ .root_module = ... })` form.
  `root_source_file` on `addExecutable` is removed in 0.16.
- `build.zig.zon` pins `minimum_zig_version = "0.16.0"` and has a
  valid `fingerprint` (never hand-edited).
- Every `fetch`ed dependency is `--save`d with a pinned hash. No
  unpinned `git+https://` URLs.
- Expose named steps: `fmt`, `test`, `test-unit`, `test-lib`,
  `test-integration`, `fuzz`, `docs`. The live adopter (`gitstore-cli`)
  already follows this contract.

## 9. Fuzz discipline

- Every public parser has a fuzz target under `fuzz/targets/`.
- Corpora live under `fuzz/corpus/<target-name>/` and are
  version-controlled for regression coverage.
- Fuzz runs on Linux. Darwin `0.16.0` native fuzz is broken upstream
  (`ziglang/zig#20986`); the gate degrades explicitly (see ADR 0003).
- Use `ZIG_QM_FORCE_FUZZ=1` only when you know why and you expect the
  failure.

## 10. Documentation

- Every `pub` declaration has a doc comment. Short is fine; absent is
  not.
- Doc comments describe **contract**, not implementation. Use the
  implementation to explain itself; use the doc to pin the invariants.
- `zig build docs` must succeed without warnings. Broken doc references
  are treated as build failures in the commit-tier gate.

## 11. What this template does not decide

This style guide is prescriptive where the language allows drift and
silent on questions where reasonable projects differ:

- Tabs vs spaces: `zig fmt` handles it; don't argue.
- Struct layout: follow the language defaults unless a FFI or ABI
  requirement forces otherwise.
- Logging backend: this template does not ship one. If your project
  adds structured logging, inject it like `std.Io` — at the boundary.

## 12. How the rules are enforced

| Rule                                    | Enforcer                          | Tier        |
|-----------------------------------------|-----------------------------------|-------------|
| `zig fmt --check`                       | `scripts/verify-fast.ts`          | Per-turn    |
| `zig ast-check`                         | `scripts/verify-fast.ts`          | Per-turn    |
| No `anyerror` in `pub`                  | `scripts/zig-fitness.zig`         | Per-commit  |
| Named error sets                        | `scripts/zig-fitness.zig`         | Per-commit  |
| Allocator propagation                   | `scripts/zig-fitness.zig`         | Per-commit  |
| `std.Io` injection                      | `scripts/zig-fitness.zig`         | Per-commit  |
| Assertion density threshold             | `scripts/zig-fitness.zig`         | Per-PR      |
| `std.testing.allocator` usage           | `scripts/zig-fitness.zig`         | Per-PR      |
| Public-API baseline                     | `scripts/check-public-api.ts`     | Per-PR      |
| Fuzz corpus coverage                    | `scripts/verify-pr.ts`            | Per-PR      |
| Reproducible release build              | `scripts/verify-release.ts`       | Per-release |
| SBOM generation                         | `scripts/emit-sbom.zig`           | Per-release |

When a rule fails, the verifier reports the specific fitness rule id,
the file and line, and the canonical fix. The `zig-fixer` subagent
knows the deterministic fix for every rule in the table above.

## 13. Reading order for new contributors

1. This file.
2. `doc/ARCHITECTURE.md` for the system shape.
3. `.claude/skills/zig-quality/SKILL.md` and its
   `references/0.16-grounded-facts.md` for anti-drift facts.
4. `doc/adr/0002-zig-0.16-pinning.md` for why the toolchain is pinned.
5. `doc/adr/0003-darwin-fuzz-degradation.md` for why macOS fuzz is a
   degraded gate.

After that, the code is the spec.
