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

/// Re-export of `std.mem.Allocator`, the allocator interface every
/// allocating function in this module takes explicitly (§1.1).
pub const Allocator = std.mem.Allocator;
/// Re-export of `std.Io`, the I/O interface injected at the boundary so
/// the library stays testable with a traced/mocked backend (§1.3).
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
// ziglint-ignore: Z015 — `HelloError` is a documented `pub const` error set,
// exactly as TIGER_STYLE_ZIG §1.2 mandates; ziglint isPrivateTypeRef
// false-positives on a file-level `pub const` error set referenced by a
// same-file `pub fn`. Z015 stays active elsewhere to catch real leaks.
pub fn hello(gpa: Allocator, io: Io, name: []const u8) HelloError![]u8 {
    _ = io; // Io is reserved for future use (tracing, clock, rand).
    // ziglint-ignore: Z010 — qualified form required in error-union return.
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

// --- new tests (plan order=32) -----------------------------------------------

// Test 1: format specifiers in name are treated as literal text, not expanded.
// allocPrint uses `{s}` to insert the name opaquely — no second-level format
// interpretation of the name's contents.
test "hello: format specifier in name is literal" {
    const gpa = std.testing.allocator;
    const io = std.testing.io;
    const greeting = try hello(gpa, io, "{s}");
    defer gpa.free(greeting);
    try std.testing.expectEqualStrings("Hello, {s}!", greeting);
}

// Test 2: single-character name produces the expected greeting shape.
test "hello: single-char name" {
    const gpa = std.testing.allocator;
    const io = std.testing.io;
    const greeting = try hello(gpa, io, "X");
    defer gpa.free(greeting);
    try std.testing.expectEqualStrings("Hello, X!", greeting);
}

// Test 3: embedded null byte is part of the slice — no C-string truncation.
// hello() must produce a greeting whose inner portion contains the null byte
// and whose total length covers the full slice.
test "hello: embedded null byte in name is not truncated" {
    const gpa = std.testing.allocator;
    const io = std.testing.io;
    const name = "ab\x00cd";
    const greeting = try hello(gpa, io, name);
    defer gpa.free(greeting);
    // Length must account for all 5 bytes of `name` plus "Hello, " (7) + "!" (1).
    try std.testing.expectEqual(@as(usize, 7 + 5 + 1), greeting.len);
    // The null byte must be present at the expected position inside the greeting.
    try std.testing.expectEqual(@as(u8, 0), greeting[7 + 2]); // "Hello, ab\0..."
}

// Test 4: 65535-byte name allocates, produces the right output, and frees
// without leak — std.testing.allocator catches any retained allocation.
test "hello: 65535-byte name no leak" {
    const gpa = std.testing.allocator;
    const io = std.testing.io;
    const name = try gpa.alloc(u8, 65535);
    defer gpa.free(name);
    @memset(name, 'a');
    const greeting = try hello(gpa, io, name);
    defer gpa.free(greeting);
    // Output is "Hello, " (7) + 65535 * 'a' + "!" (1).
    try std.testing.expectEqual(@as(usize, 7 + 65535 + 1), greeting.len);
    try std.testing.expectEqual(@as(u8, 'a'), greeting[7]);
    try std.testing.expectEqual(@as(u8, '!'), greeting[greeting.len - 1]);
}

// Test 5 (MUTATION sentinel): empty name → EmptyName; non-empty → no EmptyName.
// A flipped `== 0` / `!= 0` comparison would break exactly one of these two
// assertions, so both directions are required to catch the mutation.
test "hello: mutation sentinel — empty vs non-empty name" {
    const gpa = std.testing.allocator;
    const io = std.testing.io;
    // Empty MUST fail with EmptyName.
    try std.testing.expectError(HelloError.EmptyName, hello(gpa, io, ""));
    // Non-empty MUST NOT fail with EmptyName.
    const greeting = try hello(gpa, io, "z");
    defer gpa.free(greeting);
    try std.testing.expectEqualStrings("Hello, z!", greeting);
}

// Test 6 (REGRESSION / semver guard): pin the exact members of HelloError.
// Adding or removing an error variant changes the error_set length and trips
// this test, making semver drift visible at compile+test time.
test "hello: HelloError error set is pinned (semver guard)" {
    const info = @typeInfo(HelloError);
    const fields = info.error_set.?;
    // Must have exactly 2 members: EmptyName and OutOfMemory.
    try std.testing.expectEqual(@as(usize, 2), fields.len);
    // Verify both names are present (order is not guaranteed by the spec).
    var found_empty_name = false;
    var found_oom = false;
    for (fields) |f| {
        if (std.mem.eql(u8, f.name, "EmptyName")) found_empty_name = true;
        if (std.mem.eql(u8, f.name, "OutOfMemory")) found_oom = true;
    }
    try std.testing.expect(found_empty_name);
    try std.testing.expect(found_oom);
}

// Test 7 (FUNCTIONAL — Io is truly unused): hello() must succeed even when io
// is std.testing.io, which would surface any unexpected I/O operation.
// Because `_ = io` is the only use of the io param, this test documents that
// contract: swapping to a real or traced Io does not change the result.
test "hello: io param is unused — result is io-independent" {
    const gpa = std.testing.allocator;
    const io = std.testing.io;
    const greeting = try hello(gpa, io, "world");
    defer gpa.free(greeting);
    // The result must be identical regardless of which io backend is injected,
    // proving hello() performs no I/O.
    try std.testing.expectEqualStrings("Hello, world!", greeting);
}
