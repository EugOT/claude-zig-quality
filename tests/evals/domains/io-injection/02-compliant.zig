// eval-version: 1
//
// Compliant fixture: greet takes both an io capability AND an explicit
// writer so callers retain control over where output goes. This is the
// shape Zig 0.16 actually exposes — std.Io is an injected capability for
// concurrency and time, NOT a pre-baked writer. Stdout/stderr/file
// writers are obtained separately and threaded as parameters.
const std = @import("std");

pub fn greet(_: std.Io, w: *std.Io.Writer, name: []const u8) !void {
    // Fixture limitation, accepted: names longer than ~119 chars make
    // bufPrint return error.NoSpaceLeft. The eval tests the injection
    // pattern, not production robustness.
    var buf: [128]u8 = undefined;
    const rendered = try std.fmt.bufPrint(&buf, "hello, {s}\n", .{name});
    try w.writeAll(rendered);
}
