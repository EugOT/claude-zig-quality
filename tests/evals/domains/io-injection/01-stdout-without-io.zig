// eval-version: 1
const std = @import("std");

pub fn greet(name: []const u8) !void {
    const stdout = std.io.getStdOut().writer();
    try stdout.print("hello, {s}\n", .{name});
}
