// eval-version: 1
const std = @import("std");

pub fn greet(io: std.Io, name: []const u8) !void {
    var buf: [128]u8 = undefined;
    const rendered = try std.fmt.bufPrint(&buf, "hello, {s}\n", .{name});
    try io.out.writeAll(rendered);
}
