// eval-version: 1
const std = @import("std");

pub fn buildList(alloc: std.mem.Allocator) !std.ArrayList(u32) {
    var list: std.ArrayList(u32) = .empty;
    try list.append(alloc, 1);
    try list.append(alloc, 2);
    try list.append(alloc, 3);
    return list;
}
