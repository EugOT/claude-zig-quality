// eval-version: 1
const std = @import("std");

pub fn buildBuffer(alloc: std.mem.Allocator, size: usize) ![]u8 {
    return alloc.alloc(u8, size);
}
