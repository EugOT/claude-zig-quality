// eval-version: 1
const std = @import("std");

var module_gpa: std.heap.GeneralPurposeAllocator(.{}) = .init;

pub fn buildBuffer(size: usize) ![]u8 {
    const alloc = module_gpa.allocator();
    return alloc.alloc(u8, size);
}
