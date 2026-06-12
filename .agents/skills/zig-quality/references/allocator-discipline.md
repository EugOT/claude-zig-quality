# Zig Allocator Discipline

Zig 0.16 makes allocator propagation visible by completing the unmanaged
migration. Use that visibility aggressively — hidden allocators are now
a design smell, not a convenience. For the canonical rename and removal
facts (`DebugAllocator`, `ThreadSafeAllocator` removal), see row 2 of
`0.16-grounded-facts.md`.

## Rules

### R1 — Public fns that may allocate take `Allocator` explicitly

```zig
// Good
pub fn parse(gpa: std.mem.Allocator, input: []const u8) !Parsed { ... }

// Bad — stores allocator as a struct field
pub const Parser = struct {
    gpa: std.mem.Allocator,  // smell
    pub fn parse(self: *Parser, input: []const u8) !Parsed { ... }
};
```

Exception: types whose **purpose** is allocator-bound (arenas, pools).
They accept the backing `Allocator` at `init(gpa)` and expose
`.allocator()`.

### R2 — Unmanaged containers only

Every growable container passes the allocator per method call.

```zig
var list: std.ArrayList(T) = .empty;
defer list.deinit(gpa);
try list.append(gpa, v);
```

`std.ArrayList(T).init(...)` is pre-0.16 and must be rewritten.

### R3 — No module-level `var` outside `main.zig` / `build.zig`

Library modules must not have package-level mutable globals. Juicy Main
exists precisely to thread runtime state through function signatures.

```zig
// Bad in lib.zig
var cache: std.StringHashMap(...) = ...;

// Good
pub const Cache = struct { ... };
pub fn init(gpa: std.mem.Allocator) Cache { ... }
```

### R4 — Arenas for per-request scratch, GPAs for durable state

- Per-request, per-parse-tree, or per-build-step: `std.heap.ArenaAllocator`.
  Cheap bulk-free at end.
- Long-lived structures: `std.heap.DebugAllocator(.{})` in dev/tests;
  a `std.heap.page_allocator`-backed GPA in release.
- In tests: `std.testing.allocator` — fails the test on leak
  automatically.

### R5 — Never wrap `Allocator` in a mutex

`std.heap.ThreadSafeAllocator` was removed in 0.16 and declared an
anti-pattern. `ArenaAllocator` is already lock-free and thread-safe.
If you need per-thread arenas, allocate them per thread.

### R6 — Tests enforce leak-free via `std.testing.allocator`

```zig
test "parse releases all memory" {
    const parsed = try parse(std.testing.allocator, "x = 1");
    defer parsed.deinit(std.testing.allocator);
    try std.testing.expectEqual(@as(usize, 1), parsed.count);
}
```

`testing.allocator` asserts no leak at test exit. No extra code is
required in the test body.

### R7 — `errdefer` every allocation that outlives the current fn

```zig
const buf = try gpa.alloc(u8, n);
errdefer gpa.free(buf);
try populate(buf);
return buf;  // success path; errdefer doesn't run
```

A missing `errdefer` after an alloc is a leak waiting to happen on
error paths. This pairs with the error-set-discipline `errdefer`
rule — the allocator and error-set views are two sides of the same
resource rule.

## AST rules (for lint / grep)

Fail on:

- `var ` at module scope in files not named `main.zig` / `build.zig` →
  global smell.
- `std.ArrayList(…)\.init\(` → must use `.empty`.
- `std.heap.GeneralPurposeAllocator` → renamed to `DebugAllocator`.
- `std.heap.ThreadSafeAllocator` → removed; anti-pattern.
- `pub fn.*\(\s*\)\s*!\w+` whose body contains `.alloc(` → public fn
  allocates without taking `Allocator` parameter.

## Test-time allocator tricks

- `std.testing.allocator` — leak-detecting GPA.
- `std.testing.failing_allocator` — always returns
  `error.OutOfMemory`; use to test OOM paths.
- `std.heap.FixedBufferAllocator` — bounded-size tests (fail tests
  that exceed the budget).

Deep test-time pattern guidance: `testing-patterns.md`.

## Memory protection for security-sensitive data

0.16 standardized page-locking through `std.process`:

```zig
try std.process.lockMemory(io, secret_buf);
defer std.process.unlockMemory(io, secret_buf) catch {};
```

The older `mlock` / `mlock2` / `mlockall` wrappers were consolidated
under `std.process.lockMemory` / `std.process.lockMemoryAll`.

## Philosophy

If an allocation path is not visible in the function signature, the
code is lying to the caller. Make all allocation obvious, make all
failure visible, make leaks test-failures — the agent generating Zig
code will then produce code that passes review on the first iteration.
