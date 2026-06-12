// eval-version: 1
const std = @import("std");

pub const ParseError = error{
    InvalidCharacter,
    Overflow,
};

pub fn parseInt(text: []const u8) ParseError!i64 {
    return std.fmt.parseInt(i64, text, 10) catch |err| switch (err) {
        error.InvalidCharacter => ParseError.InvalidCharacter,
        error.Overflow => ParseError.Overflow,
    };
}
