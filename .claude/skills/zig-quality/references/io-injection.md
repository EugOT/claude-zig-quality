# Zig Io Injection — the 0.16 Capability Pattern

`std.Io` is Zig 0.16's biggest structural change. Use it correctly and
tests become deterministic by construction; use it wrong and you
rebuild a function-coloring problem inside it. For the canonical
"`std.Io` is an injected parameter" fact with pinned citation, see row
3 of `0.16-grounded-facts.md`.

## The rule

> Any function that may block control flow or introduce nondeterminism
> takes `io: std.Io` as a parameter. Any function that does neither
> does not.

"Blocking / nondeterministic" includes: filesystem, network, timers,
randomness, concurrency primitives, process spawn. It does **not**
include pure computation.

## Signatures

```zig
// Good — I/O explicit
pub fn readConfig(io: std.Io, dir: std.Io.Dir, path: []const u8) !Config {
    var file = try dir.openFile(io, path, .{});
    defer file.close(io);
    const bytes = try file.readAllAlloc(io, gpa, 1 << 20);
    return parseConfig(bytes);  // no Io — pure parse
}

// Bad — I/O hidden by a static reference
pub fn readConfig(path: []const u8) !Config {
    const file = try std.Io.Threaded.open(path);  // hidden global
    // ...
}
```

## Backends

- `std.Io.Threaded` — default; thread-pool + blocking syscalls.
  Feature-complete. Used by Juicy Main.
- `std.Io.Evented` (experimental in 0.16):
  - `Io.Uring` — Linux io_uring; missing networking/tests.
  - `Io.Kqueue` — BSD kqueue POC.
  - `Io.Dispatch` — macOS Grand Central Dispatch.
- `std.Io.failing` — tests that forbid any I/O. Use for pure-unit
  tests of code that could take `Io` but does not use it in that path.

## Testing with mock Io

```zig
test "parseConfig is pure" {
    // No Io needed — the fn signature doesn't take one, so it can't touch filesystem.
    const cfg = try parseConfig("key = value");
    try std.testing.expectEqualStrings("value", cfg.key);
}

test "readConfig on failing Io" {
    const cfg = readConfig(.failing, some_dir, "x.toml");
    try std.testing.expectError(error.Unexpected, cfg);
}
```

For VOPR-style deterministic simulation: substitute a simulator `Io`
that drives time artificially, replays network faults, and injects
disk errors on a seeded schedule. The pattern works in any 0.16
project with `Io`-injected I/O.

## Cancellation (first-class)

Every cancelable op returns `error.Canceled` (single `l`, per upstream
spelling).

```zig
const result = file.readAll(io, buf) catch |err| switch (err) {
    error.Canceled => return, // propagate cancellation
    else => return err,
};
```

Handlers can call `io.recancel()` or `io.swapCancelProtection()`.
`Io.Threaded` implements cancellation by sending signals that force
`EINTR`.

## Primitives that replaced `std.Thread.*`

| Removed | Replacement |
|---|---|
| `std.Thread.Pool` | `std.Io.async(io, fn, args)` → `Future(T)` |
| `std.Thread.Mutex` | `std.Io.Mutex` |
| `std.Thread.Condition` | `std.Io.Condition` |
| `std.Thread.Semaphore` | `std.Io.Semaphore` |
| `std.Thread.RwLock` | `std.Io.RwLock` |
| `std.Thread.ResetEvent` | `std.Io.Event` |
| `std.Thread.WaitGroup` | `std.Io.Group` |
| `std.once` | `std.Io.async` with `Once` semantics |

`std.Thread.Mutex.Recursive` was removed outright — recursive locking
is usually a design bug.

## Entropy / time

- Random: `io.random(buf)` or `io.randomSecure(buf)`. Not
  `std.crypto.random.bytes` / `posix.getrandom`.
- Time: `std.Io.Timestamp` via `.now(io)`. Not `std.time.Instant` /
  `Timer` / `timestamp`.
- Clock: `std.Io.Clock` (unit-typed `Duration` / `Timestamp` /
  `Timeout`).

Injected time means tests can simulate "10 years elapsed" in
microseconds.

## Concurrency primitives

- `Future(T)` — infallible async op.
- `Group` — structured concurrency; scope-bound child tasks auto-join
  at scope exit.
- `Queue(T)` — MPMC thread-safe queue.
- `Select` — first-complete-of-many.
- `Batch` — bulk op coalescing.

Prefer `Group` for "start N tasks, wait for all". Prefer `Select` for
"first of several triggers". Both cancel remaining work automatically
on scope exit.

## AST rules (for lint)

- Any `pub fn` body that references `std.Io.Threaded.*` directly →
  fail ("use injected Io parameter").
- Any fn body calling `file.read(`, `file.write(`, `dir.openFile(`,
  `time.now(` without an `io: std.Io` parameter in scope → fail.
- Any fn with an `io: std.Io` parameter that never uses it → fail
  (dead parameter, likely stale copy-paste).

## Common translation of 0.14 patterns

```zig
// 0.14
const cwd = std.fs.cwd();
const file = try cwd.openFile(path, .{});
defer file.close();
const contents = try file.readToEndAlloc(gpa, 1 << 20);

// 0.16 — cwd is gone; route through Dir parameter.
pub fn load(
    io: std.Io,
    dir: std.Io.Dir,
    gpa: std.mem.Allocator,
    path: []const u8,
) ![]u8 {
    var file = try dir.openFile(io, path, .{});
    defer file.close(io);
    return try file.readAllAlloc(io, gpa, 1 << 20);
}
// Caller (main.zig) gets the cwd Dir from init.preopens, passes it in.
```

## Boundary discipline

- `main.zig` receives `Io` from `init.io` (Juicy Main).
- `build.zig` receives it from `b.graph.io`.
- Everywhere else threads `Io` through arguments.
- Never construct `Io.Threaded` anywhere except `main.zig` or a test
  harness.

## Why this matters

Deterministic-by-construction libraries are the whole reason to adopt
0.16. Business logic that accepts `Io` can be:

- Tested with `Io.failing` — impossible to leak I/O into a "pure" test.
- Stress-tested with a VOPR-style simulator — one seed reproduces any
  fault chain.
- Swapped from threaded to io_uring via one flag at the `main.zig`
  boundary, no internal rewrite.

That is the capability. Use it; do not rebuild function coloring
inside it.
