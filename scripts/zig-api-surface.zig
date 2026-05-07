//! zig-api-surface — walk src/lib.zig (or any given .zig file) and emit a
//! JSON inventory of every top-level `pub fn`, `pub const`, `pub var`,
//! `pub usingnamespace` decl.
//!
//! Adapted from EugOT/gitstore-cli's scripts/zig-api-surface.zig (MIT).
//! The logic is intentionally the same: a tiny AST walker over root decls.
//!
//! Intended use:
//!   mise x zig@0.16.0 -- zig run scripts/zig-api-surface.zig -- src/lib.zig > api.json
//!   diff <(git show main:.zig-qm/public-api.txt) api.txt   # PR gate
//!
//! Output shape (JSON array):
//!   [
//!     {"name": "hello", "kind": "fn"},
//!     {"name": "HelloError", "kind": "const"},
//!     ...
//!   ]
//!
//! v1 scaffolding only — enumerates pub decls at the top level of the given
//! file. It does NOT recurse into re-exported modules; run once per module
//! file if you need the full transitive surface.

const std = @import("std");

pub fn main(init: std.process.Init) !u8 {
    const gpa = init.gpa;
    const io = init.io;

    // Parse args: first positional is the .zig file to scan.
    var arg_iter = std.process.Args.Iterator.init(init.minimal.args);
    _ = arg_iter.next(); // exe name
    const path = arg_iter.next() orelse {
        try printErr(io, "usage: zig-api-surface <path-to.zig>\n");
        return 2;
    };

    // Read source via the build_root-independent cwd.
    const source = std.Io.Dir.cwd().readFileAlloc(io, path, gpa, .unlimited) catch |err| {
        try printErrFmt(io, "cannot read {s}: {s}\n", .{ path, @errorName(err) });
        return 1;
    };
    defer gpa.free(source);

    // Null-terminate for std.zig.Ast.
    const source_z = try gpa.dupeZ(u8, source);
    defer gpa.free(source_z);

    var ast = try std.zig.Ast.parse(gpa, source_z, .zig);
    defer ast.deinit(gpa);

    if (ast.errors.len > 0) {
        try printErrFmt(io, "parse errors in {s}\n", .{path});
        return 1;
    }

    var out_buf: [8192]u8 = undefined;
    var stdout_w = std.Io.File.stdout().writerStreaming(io, &out_buf);
    const w = &stdout_w.interface;

    try w.print("[\n", .{});

    const root_decls = ast.rootDecls();
    var first = true;
    for (root_decls) |decl_idx| {
        const entry = classifyDecl(ast, decl_idx) orelse continue; // non-pub decls skipped
        if (!first) try w.print(",\n", .{});
        first = false;
        try w.print("  {{\"name\": \"{s}\", \"kind\": \"{s}\"}}", .{ entry.name, entry.kind });
    }

    try w.print("\n]\n", .{});
    try w.flush();
    return 0;
}

const Entry = struct { name: []const u8, kind: []const u8 };

/// Classify a top-level decl. Returns null for non-pub decls.
fn classifyDecl(ast: std.zig.Ast, decl_idx: std.zig.Ast.Node.Index) ?Entry {
    const tags = ast.nodes.items(.tag);
    const main_tokens = ast.nodes.items(.main_token);
    const token_tags = ast.tokens.items(.tag);

    const tag = tags[@intFromEnum(decl_idx)];

    switch (tag) {
        // pub fn foo(...) ...
        .fn_decl,
        .fn_proto_simple,
        .fn_proto_multi,
        .fn_proto_one,
        .fn_proto,
        => {
            const main_tok = main_tokens[@intFromEnum(decl_idx)];
            // Walk back to find `pub` keyword.
            if (!hasPubBefore(token_tags, main_tok)) return null;
            const name_tok = findFnNameToken(ast, decl_idx) orelse return null;
            return .{ .name = ast.tokenSlice(name_tok), .kind = "fn" };
        },
        // pub const X = ...  ;  pub var X = ...
        .simple_var_decl,
        .local_var_decl,
        .global_var_decl,
        .aligned_var_decl,
        => {
            const main_tok = main_tokens[@intFromEnum(decl_idx)];
            if (!hasPubBefore(token_tags, main_tok)) return null;
            const kind: []const u8 = if (token_tags[main_tok] == .keyword_const) "const" else "var";
            // name is the identifier following the main token (const/var).
            const name_tok = main_tok + 1;
            if (name_tok >= token_tags.len) return null;
            if (token_tags[name_tok] != .identifier) return null;
            return .{ .name = ast.tokenSlice(name_tok), .kind = kind };
        },
        else => return null,
    }
}

/// Returns true if the nearest non-doc-comment token before `tok` is `pub`.
fn hasPubBefore(token_tags: []const std.zig.Token.Tag, tok: std.zig.Ast.TokenIndex) bool {
    if (tok == 0) return false;
    var i: usize = @as(usize, tok);
    while (i > 0) {
        i -= 1;
        const t = token_tags[i];
        switch (t) {
            .keyword_pub => return true,
            .doc_comment, .container_doc_comment => continue,
            else => return false,
        }
    }
    return false;
}

/// Locate the identifier token naming a function decl.
fn findFnNameToken(ast: std.zig.Ast, decl_idx: std.zig.Ast.Node.Index) ?std.zig.Ast.TokenIndex {
    // `fn foo(...)` — the main token is `fn`; the name is the next identifier.
    const main_tok = ast.nodes.items(.main_token)[@intFromEnum(decl_idx)];
    const token_tags = ast.tokens.items(.tag);
    var i: usize = @as(usize, main_tok);
    const end = @min(i + 4, token_tags.len);
    while (i < end) : (i += 1) {
        if (token_tags[i] == .identifier) return @intCast(i);
    }
    return null;
}

fn printErr(io: std.Io, msg: []const u8) !void {
    var buf: [256]u8 = undefined;
    var w = std.Io.File.stderr().writerStreaming(io, &buf);
    try w.interface.print("{s}", .{msg});
    try w.flush();
}

fn printErrFmt(io: std.Io, comptime fmt: []const u8, args: anytype) !void {
    var buf: [512]u8 = undefined;
    var w = std.Io.File.stderr().writerStreaming(io, &buf);
    try w.interface.print(fmt, args);
    try w.flush();
}
