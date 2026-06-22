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

// ---- new tests (plan order 33) -------------------------------------------
//
// NOTE: `pub fn main(init: std.process.Init) !u8` cannot be invoked directly
// in test code because `std.process.Init` is constructed exclusively by the
// Zig runtime (the "Juicy Main" idiom). There is no public constructor and no
// test helper that fabricates one. We therefore test the *logic* that main()
// exercises — `lib.hello` + a buffer-backed streaming writer + flush — using
// `std.testing.io` and `std.testing.allocator`, which together give us the
// same deterministic behaviour without the runtime harness. The binary's
// end-to-end output (exact bytes on stdout, exit code) is covered by the TS
// e2e in tests/e2e/root-binary.test.ts.

/// Build the greeting that `main` would produce for a given name.
/// Extracted so the three tests below can share the logic without repeating it.
fn buildGreetingLine(gpa: std.mem.Allocator, io: std.Io, name: []const u8) ![]u8 {
    const greeting = try lib.hello(gpa, io, name);
    defer gpa.free(greeting);
    return std.fmt.allocPrint(gpa, "{s}\n", .{greeting});
}

test "root: greeting for canonical binary name is correct" {
    // Mirrors the exact lib.hello call in main() with the binary's name.
    // Confirms the greeting string that the e2e test asserts on stdout.
    const gpa = std.testing.allocator;
    const io = std.testing.io;
    const line = try buildGreetingLine(gpa, io, "claude-zig-quality");
    defer gpa.free(line);
    try std.testing.expectEqualStrings("Hello, claude-zig-quality!\n", line);
}

test "root: greeting is written through the print path into a buffer" {
    // Regression for the greeting write path main() uses: format the greeting
    // through a std.Io.Writer and confirm the exact bytes land in the buffer.
    //
    // IMPORTANT: this writes into an in-memory `std.Io.Writer.fixed` buffer, NOT
    // `std.Io.File.stdout()`. A test that writes to real stdout corrupts the
    // `zig build` test runner's `--listen=-` stdout IPC channel and HANGS the
    // whole `test` step (it passes under a bare `zig test` without --listen,
    // which is why the hang only showed up under `zig build test`). Never write
    // to the real stdout/stderr fds from a unit test.
    const gpa = std.testing.allocator;
    const io = std.testing.io;

    const greeting = try lib.hello(gpa, io, "flush-check");
    defer gpa.free(greeting);

    var backing: [256]u8 = undefined;
    var w: std.Io.Writer = .fixed(&backing);
    try w.print("{s}\n", .{greeting});

    // .fixed records everything written; w.buffered() is the slice committed so
    // far. This asserts the print path produced the exact expected bytes.
    try std.testing.expectEqualStrings("Hello, flush-check!\n", w.buffered());
}

test "root: main exits successfully on the happy path (logic only)" {
    // Confirms that `lib.hello` — the only fallible call in main() — does NOT
    // return an error for a non-empty name. If this test fails it means main()
    // would propagate an error and exit non-zero, which the e2e test would
    // also catch. Having it here surfaces the failure faster and pinpoints it.
    const gpa = std.testing.allocator;
    const io = std.testing.io;
    const greeting = try lib.hello(gpa, io, "claude-zig-quality");
    defer gpa.free(greeting);
    // Must not have returned an error (we reached this line).
    // Verify the returned slice is non-empty for belt-and-suspenders safety.
    try std.testing.expect(greeting.len > 0);
}
