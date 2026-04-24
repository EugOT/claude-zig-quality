//! Alternate module demonstrating that allocator discipline is module-local.
//!
//! Where `lib.hello` uses a caller-supplied general-purpose allocator, this
//! module's `parseGreeting` shows the arena pattern: internal scratch work
//! happens in a private arena, but the caller-visible output is copied into
//! the caller's allocator so ownership is unambiguous.
//!
//! The architecture-fitness walker (scripts/zig-fitness.zig) treats both
//! disciplines as valid — what it rejects is hidden global allocators.

const std = @import("std");

pub const Allocator = std.mem.Allocator;

/// Owned output of `parseGreeting`. Caller must call `deinit` with the same
/// allocator passed to `parseGreeting`.
pub const ParsedGreeting = struct {
    prefix: []u8,
    name: []u8,

    pub fn deinit(self: *ParsedGreeting, gpa: Allocator) void {
        gpa.free(self.prefix);
        gpa.free(self.name);
        self.* = undefined;
    }
};

/// Named error set. Keeping the surface explicit is rule #1 of the fitness
/// checker: inferred `!T` on a public function is a warning.
pub const ParseError = error{
    /// Input did not match the expected "<prefix>, <name>!" shape.
    MalformedGreeting,
    /// Caller passed an empty input.
    Empty,
} || Allocator.Error;

/// Parse a greeting of the form "Hello, world!" into its prefix and name.
///
/// Allocator discipline: we run the tokenizing work under a private arena so
/// the hot path does not fragment the caller's allocator. Only the two owned
/// slices in `ParsedGreeting` are allocated in the caller's allocator.
pub fn parseGreeting(gpa: Allocator, input: []const u8) ParseError!ParsedGreeting {
    if (input.len == 0) return ParseError.Empty;

    // Private arena for scratch work. This arena is fully contained within
    // the call: nothing escapes to the caller.
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const comma = std.mem.indexOfScalar(u8, input, ',') orelse return ParseError.MalformedGreeting;
    if (!std.mem.endsWith(u8, input, "!")) return ParseError.MalformedGreeting;

    // Scratch copies live in the arena — freed automatically.
    const prefix_scratch = try arena.dupe(u8, std.mem.trim(u8, input[0..comma], " "));
    const name_scratch = try arena.dupe(u8, std.mem.trim(u8, input[comma + 1 .. input.len - 1], " "));

    if (prefix_scratch.len == 0 or name_scratch.len == 0) return ParseError.MalformedGreeting;

    // Final copies live in the caller's allocator.
    const prefix = try gpa.dupe(u8, prefix_scratch);
    errdefer gpa.free(prefix);
    const name = try gpa.dupe(u8, name_scratch);
    errdefer gpa.free(name);

    return .{ .prefix = prefix, .name = name };
}

// -------------------------------------------------------------------- tests

test "parseGreeting round-trips Hello, world!" {
    const gpa = std.testing.allocator;
    var g = try parseGreeting(gpa, "Hello, world!");
    defer g.deinit(gpa);
    try std.testing.expectEqualStrings("Hello", g.prefix);
    try std.testing.expectEqualStrings("world", g.name);
}

test "parseGreeting rejects missing bang" {
    const gpa = std.testing.allocator;
    try std.testing.expectError(ParseError.MalformedGreeting, parseGreeting(gpa, "Hello, world"));
}

test "parseGreeting rejects empty" {
    const gpa = std.testing.allocator;
    try std.testing.expectError(ParseError.Empty, parseGreeting(gpa, ""));
}

test "parseGreeting rejects empty name" {
    const gpa = std.testing.allocator;
    try std.testing.expectError(ParseError.MalformedGreeting, parseGreeting(gpa, "Hi, !"));
}
