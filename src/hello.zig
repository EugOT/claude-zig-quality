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

/// Re-export of `std.mem.Allocator`; `parseGreeting` takes one explicitly
/// so the caller owns allocation lifetime (§1.1).
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
// ziglint-ignore: Z015 — `ParseError` is a documented `pub const` error set,
// exactly as TIGER_STYLE_ZIG §1.2 mandates; ziglint isPrivateTypeRef
// false-positives on a file-level `pub const` error set referenced by a
// same-file `pub fn`. Z015 stays active elsewhere to catch real leaks.
pub fn parseGreeting(gpa: Allocator, input: []const u8) ParseError!ParsedGreeting {
    // ziglint-ignore: Z010 — qualified form required in error-union return.
    if (input.len == 0) return ParseError.Empty;

    // Private arena for scratch work. This arena is fully contained within
    // the call: nothing escapes to the caller.
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    // ziglint-ignore: Z010 — qualified form required in error-union return.
    const comma = std.mem.indexOfScalar(u8, input, ',') orelse return ParseError.MalformedGreeting;
    // ziglint-ignore: Z010 — qualified form required in error-union return.
    if (!std.mem.endsWith(u8, input, "!")) return ParseError.MalformedGreeting;

    // Scratch copies live in the arena — freed automatically.
    const prefix_scratch = try arena.dupe(u8, std.mem.trim(u8, input[0..comma], " "));
    const name_scratch = try arena.dupe(u8, std.mem.trim(u8, input[comma + 1 .. input.len - 1], " "));

    // ziglint-ignore: Z010 — qualified form required in error-union return.
    if (prefix_scratch.len == 0 or name_scratch.len == 0) return ParseError.MalformedGreeting;

    // Final copies live in the caller's allocator.
    const prefix = try gpa.dupe(u8, prefix_scratch);
    errdefer gpa.free(prefix);
    const name = try gpa.dupe(u8, name_scratch);

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

// ---- new tests (plan order 31) ----------------------------------------

test "parseGreeting rejects no comma" {
    // A well-formed-looking string that ends with '!' but has no ',' must
    // hit the MalformedGreeting branch, not the Empty branch.
    const gpa = std.testing.allocator;
    try std.testing.expectError(ParseError.MalformedGreeting, parseGreeting(gpa, "Helloworld!"));
}

test "parseGreeting rejects whitespace-only prefix" {
    // "   , world!" has a comma and ends with '!' but the trimmed prefix
    // is empty — MalformedGreeting.
    const gpa = std.testing.allocator;
    try std.testing.expectError(ParseError.MalformedGreeting, parseGreeting(gpa, "   , world!"));
}

test "parseGreeting trailing content after bang is rejected" {
    // The documented contract: input must END with '!'. Any character after
    // the exclamation mark makes endsWith false → MalformedGreeting.
    const gpa = std.testing.allocator;
    try std.testing.expectError(ParseError.MalformedGreeting, parseGreeting(gpa, "Hello, world! "));
    try std.testing.expectError(ParseError.MalformedGreeting, parseGreeting(gpa, "Hello, world!x"));
}

test "parseGreeting trims surrounding spaces from prefix and name" {
    const gpa = std.testing.allocator;
    var g = try parseGreeting(gpa, "  Greetings  ,  Alice  !");
    defer g.deinit(gpa);
    try std.testing.expectEqualStrings("Greetings", g.prefix);
    try std.testing.expectEqualStrings("Alice", g.name);
}

test "parseGreeting comma-only rejects both sides" {
    // ",!" — comma present, ends with '!', but both trimmed sides are empty.
    const gpa = std.testing.allocator;
    try std.testing.expectError(ParseError.MalformedGreeting, parseGreeting(gpa, ",!"));
}

test "parseGreeting rejects empty prefix with valid name" {
    // " , Bob!" — comma at start (whitespace-only prefix), valid name.
    const gpa = std.testing.allocator;
    try std.testing.expectError(ParseError.MalformedGreeting, parseGreeting(gpa, " , Bob!"));
}

test "parseGreeting mutation sentinel: endsWith not startsWith" {
    // '!Hello, world!' starts with '!' but does NOT end with '!' — a mutation
    // that swaps endsWith→startsWith would falsely accept this input.
    // Correct behaviour: reject with MalformedGreeting.
    const gpa = std.testing.allocator;
    try std.testing.expectError(ParseError.MalformedGreeting, parseGreeting(gpa, "!Hello, world"));
    // Sanity: the version that truly ends with '!' still parses fine.
    var g = try parseGreeting(gpa, "Hello, world!");
    defer g.deinit(gpa);
    try std.testing.expectEqualStrings("Hello", g.prefix);
    try std.testing.expectEqualStrings("world", g.name);
}

test "parseGreeting errdefer: second gpa alloc failure does not leak first" {
    // parseGreeting does two gpa.dupe calls after the arena work:
    //   1. gpa.dupe(u8, prefix_scratch)  → alloc #1
    //   2. gpa.dupe(u8, name_scratch)    → alloc #2  (guarded by errdefer)
    // We allow the first alloc but fail the second. The errdefer on the
    // prefix slice must fire, giving the backing std.testing.allocator a
    // chance to detect the leak. If it did not fire, the test fails
    // automatically because std.testing.allocator reports unfreed memory.
    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{ .fail_index = 1 });
    const result = parseGreeting(failing.allocator(), "Hello, world!");
    try std.testing.expectError(error.OutOfMemory, result);
    // No leak check needed here: the backing allocator (std.testing.allocator)
    // will fail this test automatically if prefix was not freed by errdefer.
}

test "parseGreeting OOM on first gpa alloc" {
    // Fail immediately on the very first allocation.
    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{ .fail_index = 0 });
    const result = parseGreeting(failing.allocator(), "Hi, there!");
    try std.testing.expectError(error.OutOfMemory, result);
}

test "parseGreeting no leak on success — deinit coverage" {
    // Exercises the full happy path and calls deinit, confirming that
    // std.testing.allocator sees a balanced alloc/free count.
    const gpa = std.testing.allocator;
    var g = try parseGreeting(gpa, "Hey, Zig!");
    defer g.deinit(gpa);
    try std.testing.expectEqualStrings("Hey", g.prefix);
    try std.testing.expectEqualStrings("Zig", g.name);
}

/// Fuzz helper: feeds one Smith-generated byte slice to parseGreeting and
/// asserts it never panics — only returns a valid ParsedGreeting or an
/// error that belongs to ParseError.
fn fuzzParseGreeting(gpa: std.mem.Allocator, smith: *std.testing.Smith) anyerror!void {
    var buf: [256]u8 = undefined;
    // sliceWithHash fills buf with Smith-generated bytes and returns a hash
    // seed for chaining; the seed is discarded here.
    const seed = smith.sliceWithHash(&buf, 0);
    // Use u8 for length to avoid the fixed-bitsize ABI restriction on usize;
    // cap at buf.len (256) which fits in u8 exactly.
    const len_u8 = smith.valueRangeAtMostWithHash(u8, 0, 255, seed);
    const input = buf[0..len_u8];

    const result = parseGreeting(gpa, input);
    if (result) |*g| {
        // Got a valid result — deinit to confirm no leak.
        var owned = g.*;
        owned.deinit(gpa);
    } else |err| {
        // The error must belong to ParseError — no other errors are permitted.
        // This switch is exhaustive over ParseError; if parseGreeting ever
        // returns an error outside the set, this becomes a compile error.
        switch (err) {
            ParseError.MalformedGreeting,
            ParseError.Empty,
            ParseError.OutOfMemory,
            => {},
        }
    }
}

test "fuzz parseGreeting never panics" {
    // std.testing.fuzz drives fuzzParseGreeting with Smith-generated inputs.
    // When run under `zig build test` (non-fuzz mode) the corpus is empty and
    // Smith generates one deterministic pass — exercising the harness wiring.
    // Under `zig build fuzz` the engine provides real coverage-guided input.
    try std.testing.fuzz(std.testing.allocator, fuzzParseGreeting, .{});
}
