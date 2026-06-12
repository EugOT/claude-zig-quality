// eval-version: 1
const std = @import("std");

pub fn buildList(alloc: std.mem.Allocator) !std.ArrayList(u32) {
    var list = std.ArrayList(u32).init(alloc);
    try list.append(1);
    try list.append(2);
    try list.append(3);
    return list;
}
