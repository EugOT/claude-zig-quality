// eval-version: 1
const std = @import("std");

pub fn parseInt(text: []const u8) anyerror!i64 {
    return std.fmt.parseInt(i64, text, 10);
}
