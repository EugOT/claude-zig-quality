//! zig-api-surface — walk src/lib.zig (or any given .zig file) and emit a
//! JSON inventory of every top-level `pub fn`, `pub const`, and `pub var`
//! decl.
//!
//! NOTE: `pub usingnamespace` is intentionally NOT classified. The
//! `usingnamespace` keyword was removed from the language in Zig 0.15.1
//! (still gone in 0.16), so it cannot appear in any file this tool targets
//! — and the fitness gate (scripts/zig-fitness.zig) bans it outright. A
//! re-export surface in 0.16 is expressed as `pub const X = @import(...)`
//! (a `pub const`), which IS captured here. classifyDecl() therefore only
//! handles fn and var/const declaration tags.
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
    // Args.Iterator.init is @compileError on Windows/WASI; toSlice with the
    // process arena is the cross-platform 0.16 pattern.
    const args = try init.minimal.args.toSlice(init.arena.allocator());
    if (args.len < 2) {
        try printErr(io, "usage: zig-api-surface <path-to.zig>\n");
        return 2;
    }
    const path = args[1];

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
    var i: usize = tok;
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
    var i: usize = main_tok;
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

// classifyDecl tests

test "classifyDecl: pub fn yields name and kind=fn" {
    const alloc = std.testing.allocator;
    const src =
        \\pub fn greet(name: []const u8) void { _ = name; }
        \\
    ;
    const srcz = try alloc.dupeZ(u8, src);
    defer alloc.free(srcz);
    var ast = try std.zig.Ast.parse(alloc, srcz, .zig);
    defer ast.deinit(alloc);
    try std.testing.expectEqual(@as(usize, 0), ast.errors.len);

    const decls = ast.rootDecls();
    try std.testing.expectEqual(@as(usize, 1), decls.len);
    const entry = classifyDecl(ast, decls[0]) orelse {
        return error.ClassifyReturnedNull;
    };
    try std.testing.expectEqualStrings("greet", entry.name);
    try std.testing.expectEqualStrings("fn", entry.kind);
}

test "classifyDecl: private fn yields null" {
    const alloc = std.testing.allocator;
    const src =
        \\fn secret() void {}
        \\
    ;
    const srcz = try alloc.dupeZ(u8, src);
    defer alloc.free(srcz);
    var ast = try std.zig.Ast.parse(alloc, srcz, .zig);
    defer ast.deinit(alloc);

    const decls = ast.rootDecls();
    try std.testing.expectEqual(@as(usize, 1), decls.len);
    const result = classifyDecl(ast, decls[0]);
    try std.testing.expectEqual(@as(?Entry, null), result);
}

test "classifyDecl: pub const yields name and kind=const" {
    const alloc = std.testing.allocator;
    const src =
        \\pub const max_size: usize = 64;
        \\
    ;
    const srcz = try alloc.dupeZ(u8, src);
    defer alloc.free(srcz);
    var ast = try std.zig.Ast.parse(alloc, srcz, .zig);
    defer ast.deinit(alloc);
    try std.testing.expectEqual(@as(usize, 0), ast.errors.len);

    const decls = ast.rootDecls();
    try std.testing.expectEqual(@as(usize, 1), decls.len);
    const entry = classifyDecl(ast, decls[0]) orelse {
        return error.ClassifyReturnedNull;
    };
    try std.testing.expectEqualStrings("max_size", entry.name);
    try std.testing.expectEqualStrings("const", entry.kind);
}

test "classifyDecl: pub var yields name and kind=var" {
    const alloc = std.testing.allocator;
    const src =
        \\pub var counter: u32 = 0;
        \\
    ;
    const srcz = try alloc.dupeZ(u8, src);
    defer alloc.free(srcz);
    var ast = try std.zig.Ast.parse(alloc, srcz, .zig);
    defer ast.deinit(alloc);
    try std.testing.expectEqual(@as(usize, 0), ast.errors.len);

    const decls = ast.rootDecls();
    try std.testing.expectEqual(@as(usize, 1), decls.len);
    const entry = classifyDecl(ast, decls[0]) orelse {
        return error.ClassifyReturnedNull;
    };
    try std.testing.expectEqualStrings("counter", entry.name);
    try std.testing.expectEqualStrings("var", entry.kind);
}

test "classifyDecl: private const yields null" {
    const alloc = std.testing.allocator;
    const src =
        \\const internal: u8 = 0;
        \\
    ;
    const srcz = try alloc.dupeZ(u8, src);
    defer alloc.free(srcz);
    var ast = try std.zig.Ast.parse(alloc, srcz, .zig);
    defer ast.deinit(alloc);

    const decls = ast.rootDecls();
    try std.testing.expectEqual(@as(usize, 1), decls.len);
    const result = classifyDecl(ast, decls[0]);
    try std.testing.expectEqual(@as(?Entry, null), result);
}

test "classifyDecl: test block yields null (else arm)" {
    const alloc = std.testing.allocator;
    // A test block at the top level must not appear as a public decl.
    const src =
        \\const std = @import("std");
        \\test "example" { try std.testing.expect(true); }
        \\
    ;
    const srcz = try alloc.dupeZ(u8, src);
    defer alloc.free(srcz);
    var ast = try std.zig.Ast.parse(alloc, srcz, .zig);
    defer ast.deinit(alloc);

    // Walk all root decls; the test block must produce null.
    var found_non_null = false;
    for (ast.rootDecls()) |d| {
        if (classifyDecl(ast, d)) |_| {
            found_non_null = true;
        }
    }
    try std.testing.expect(!found_non_null);
}

test "classifyDecl: multiple mixed decls in one parse" {
    const alloc = std.testing.allocator;
    const src =
        \\pub fn alpha() void {}
        \\fn beta() void {}
        \\pub const Gamma = 3;
        \\const delta = 4;
        \\pub var epsilon: u8 = 5;
        \\
    ;
    const srcz = try alloc.dupeZ(u8, src);
    defer alloc.free(srcz);
    var ast = try std.zig.Ast.parse(alloc, srcz, .zig);
    defer ast.deinit(alloc);
    try std.testing.expectEqual(@as(usize, 0), ast.errors.len);

    var pub_count: usize = 0;
    for (ast.rootDecls()) |d| {
        if (classifyDecl(ast, d)) |_| pub_count += 1;
    }
    // alpha (fn), Gamma (const), epsilon (var) — 3 pub decls.
    try std.testing.expectEqual(@as(usize, 3), pub_count);
}

// hasPubBefore tests

test "hasPubBefore: token index 0 returns false (underflow guard)" {
    // Construct a minimal token slice with a single keyword_fn at index 0.
    const tags = [_]std.zig.Token.Tag{.keyword_fn};
    try std.testing.expect(!hasPubBefore(&tags, 0));
}

test "hasPubBefore: pub immediately before fn token returns true" {
    const alloc = std.testing.allocator;
    const src =
        \\pub fn visible() void {}
        \\
    ;
    const srcz = try alloc.dupeZ(u8, src);
    defer alloc.free(srcz);
    var ast = try std.zig.Ast.parse(alloc, srcz, .zig);
    defer ast.deinit(alloc);

    const main_tokens = ast.nodes.items(.main_token);
    const token_tags = ast.tokens.items(.tag);
    // rootDecls()[0] is the fn_decl; its main_token is the `fn` keyword.
    const main_tok = main_tokens[@intFromEnum(ast.rootDecls()[0])];
    try std.testing.expect(hasPubBefore(token_tags, main_tok));
}

test "hasPubBefore: doc_comment between pub and fn is skipped, still true" {
    const alloc = std.testing.allocator;
    const src =
        \\/// documented
        \\pub fn visible() void {}
        \\
    ;
    const srcz = try alloc.dupeZ(u8, src);
    defer alloc.free(srcz);
    var ast = try std.zig.Ast.parse(alloc, srcz, .zig);
    defer ast.deinit(alloc);

    const main_tokens = ast.nodes.items(.main_token);
    const token_tags = ast.tokens.items(.tag);
    const main_tok = main_tokens[@intFromEnum(ast.rootDecls()[0])];
    try std.testing.expect(hasPubBefore(token_tags, main_tok));
}

test "hasPubBefore: no pub before private fn returns false" {
    const alloc = std.testing.allocator;
    const src =
        \\fn hidden() void {}
        \\
    ;
    const srcz = try alloc.dupeZ(u8, src);
    defer alloc.free(srcz);
    var ast = try std.zig.Ast.parse(alloc, srcz, .zig);
    defer ast.deinit(alloc);

    const main_tokens = ast.nodes.items(.main_token);
    const token_tags = ast.tokens.items(.tag);
    const main_tok = main_tokens[@intFromEnum(ast.rootDecls()[0])];
    try std.testing.expect(!hasPubBefore(token_tags, main_tok));
}

// findFnNameToken tests

test "findFnNameToken: returns identifier for a simple pub fn" {
    const alloc = std.testing.allocator;
    const src =
        \\pub fn compute(x: u32) u32 { return x; }
        \\
    ;
    const srcz = try alloc.dupeZ(u8, src);
    defer alloc.free(srcz);
    var ast = try std.zig.Ast.parse(alloc, srcz, .zig);
    defer ast.deinit(alloc);

    const decls = ast.rootDecls();
    const tok = findFnNameToken(ast, decls[0]);
    try std.testing.expect(tok != null);
    try std.testing.expectEqualStrings("compute", ast.tokenSlice(tok.?));
}

test "findFnNameToken: finds name within 4-token window for multi-param fn" {
    // findFnNameToken scans at most 4 tokens from the main_token (`fn`).
    // In valid Zig, `fn <identifier>` is always within that window.
    // The guard exists for defence-in-depth against malformed ASTs.
    // We verify it correctly resolves the name for the worst normal case
    // (many params — name is still at offset 1 from `fn`).
    const alloc = std.testing.allocator;
    const src =
        \\pub fn longName(a: u8, b: u16, c: u32, d: u64) void { _ = .{ a, b, c, d }; }
        \\
    ;
    const srcz = try alloc.dupeZ(u8, src);
    defer alloc.free(srcz);
    var ast = try std.zig.Ast.parse(alloc, srcz, .zig);
    defer ast.deinit(alloc);

    const tok = findFnNameToken(ast, ast.rootDecls()[0]);
    // Should find `longName` within the lookahead window.
    try std.testing.expect(tok != null);
    try std.testing.expectEqualStrings("longName", ast.tokenSlice(tok.?));
}
