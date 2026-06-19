//! Root executable shim for claude-zig-quality.
//!
//! The shipped binary is a thin demo that exercises the public library
//! surface. Real consumers depend on `src/lib.zig` via the `claude_zig_quality`
//! module; this file exists so `zig build` produces an installable artifact
//! and so the build graph matches the gitstore-cli shape exactly.

const std = @import("std");

/// Public library surface — the module consumers import as
/// `@import("claude_zig_quality")`. See `src/lib.zig`.
pub const lib = @import("lib.zig");
/// Alternate allocator-discipline surface kept in its own file to show
/// allocator state is module-local, not global. See `src/hello.zig`.
pub const hello_module = @import("hello.zig");

pub fn main(init: std.process.Init) !u8 {
    const gpa = init.gpa;
    const io = init.io;

    const greeting = try lib.hello(gpa, io, "claude-zig-quality");
    defer gpa.free(greeting);

    var buf: [256]u8 = undefined;
    var w = std.Io.File.stdout().writerStreaming(io, &buf);
    try w.interface.print("{s}\n", .{greeting});
    try w.flush();
    return 0;
}

test "root: re-exports lib.hello" {
    const gpa = std.testing.allocator;
    const io = std.testing.io;
    const g = try lib.hello(gpa, io, "root");
    defer gpa.free(g);
    try std.testing.expectEqualStrings("Hello, root!", g);
}

test "root: re-exports hello_module.parseGreeting" {
    const gpa = std.testing.allocator;
    var parsed = try hello_module.parseGreeting(gpa, "Hello, root!");
    defer parsed.deinit(gpa);
    try std.testing.expectEqualStrings("root", parsed.name);
}
