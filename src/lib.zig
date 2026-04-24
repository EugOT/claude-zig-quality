//! Public library surface for claude-zig-quality.
//!
//! This module is the canonical public API. Consumers import it as:
//!   const czq = @import("claude_zig_quality");
//!   const greeting = try czq.hello(gpa, io, "world");
//!
//! Cultural rules demonstrated here (the same four rules that scripts/
//! zig-fitness.zig enforces across the repo):
//!
//!   1. **Named error sets** — every `pub fn` declares a concrete error set
//!      so consumers can `switch (err)` without surprise variants.
//!   2. **Allocator propagation** — every allocating `pub fn` takes an
//!      `std.mem.Allocator` argument. No hidden globals, no default gpa.
//!   3. **Io injection** — every `pub fn` that touches filesystem, process,
//!      time, or random takes `std.Io`. No implicit global cwd or clock.
//!   4. **Testing allocator** — every `test` block uses
//!      `std.testing.allocator` so leaks surface as test failures.

const std = @import("std");

pub const Allocator = std.mem.Allocator;
pub const Io = std.Io;

/// Named error set for `hello`. Keeps the public API auditable: adding a new
/// variant is a semver-visible change picked up by scripts/zig-api-surface.zig.
pub const HelloError = error{
    /// Caller passed a zero-length name; greetings need a subject.
    EmptyName,
} || Allocator.Error;

/// Return a freshly-allocated greeting for `name`. Caller owns the slice.
///
/// Demonstrates the four cultural rules in ~10 lines:
///   - allocator argument (rule 2)
///   - io argument, even though we do not touch it here — the shape matters
///     because it lets us swap to a tracing Io in tests (rule 3)
///   - named error set (rule 1)
///   - tested via std.testing.allocator below (rule 4)
pub fn hello(gpa: Allocator, io: Io, name: []const u8) HelloError![]u8 {
    _ = io; // Io is reserved for future use (tracing, clock, rand).
    if (name.len == 0) return HelloError.EmptyName;
    return std.fmt.allocPrint(gpa, "Hello, {s}!", .{name});
}

// -------------------------------------------------------------------- tests

test "hello returns greeting" {
    const gpa = std.testing.allocator;
    const io = std.testing.io;
    const greeting = try hello(gpa, io, "world");
    defer gpa.free(greeting);
    try std.testing.expectEqualStrings("Hello, world!", greeting);
}

test "hello rejects empty name" {
    const gpa = std.testing.allocator;
    const io = std.testing.io;
    try std.testing.expectError(HelloError.EmptyName, hello(gpa, io, ""));
}

test "hello: multiple calls do not leak" {
    const gpa = std.testing.allocator;
    const io = std.testing.io;
    inline for (.{ "alice", "bob", "carol" }) |n| {
        const g = try hello(gpa, io, n);
        defer gpa.free(g);
        try std.testing.expect(std.mem.startsWith(u8, g, "Hello, "));
    }
}
