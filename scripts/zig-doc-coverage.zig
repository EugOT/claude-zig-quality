//! zig-doc-coverage — fail when any top-level `pub` declaration in a Zig
//! source file lacks a doc comment (`///`). This enforces TIGER_STYLE_ZIG
//! §10: "Every `pub` declaration has a doc comment. Short is fine; absent
//! is not."
//!
//! It is a sibling of scripts/zig-api-surface.zig and shares its tiny
//! root-decl AST walker, but stays a SEPARATE tool: api-surface answers
//! "what is the public surface?" while doc-coverage answers "is the public
//! surface documented?". Keeping them decoupled means a change to the
//! coverage policy (e.g. exempting a new decl kind) never perturbs the
//! API-baseline diff, and vice versa.
//!
//! Doc-comment attachment (verified against Zig 0.16 `std.zig.Ast`):
//!   - `ast.firstToken(decl)` of a `pub` decl is the `keyword_pub` token.
//!   - A `///` doc comment is a single `.doc_comment` token sitting
//!     IMMEDIATELY before that first token. A plain `//` comment is not a
//!     token at all, so it is correctly invisible here.
//!   - Therefore a pub decl is documented iff the token at
//!     `firstToken - 1` is `.doc_comment`.
//!
//! Sanctioned exception — `pub fn main`. The program entrypoint is wired by
//! the runtime, has no external callers, and its contract is documented by
//! the language, not the project. §1.2 already whitelists `main` for the
//! error-set rule; doc-coverage whitelists it for the same reason. Every
//! other `pub` decl must carry a doc comment.
//!
//! Intended use:
//!   mise x zig@0.16.0 -- zig run scripts/zig-doc-coverage.zig -- src/lib.zig
//!
//! Exit codes:
//!   0 — every public decl is documented (or the file has none)
//!   1 — at least one undocumented public decl, OR an I/O / parse error
//!   2 — usage error
//!
//! Output: one `file:line: undocumented pub <kind> '<name>'` line per
//! violation on stderr, plus a trailing summary; nothing on stdout when
//! clean so the tool composes quietly in the gate.

const std = @import("std");

const max_source_bytes: usize = 4 << 20; // 4 MiB; far above any real module.

pub fn main(init: std.process.Init) !u8 {
    const gpa = init.gpa;
    const io = init.io;

    // First positional is the .zig file to scan. Args.Iterator.init is a
    // @compileError on Windows/WASI; toSlice with the process arena is the
    // cross-platform 0.16 pattern (mirrors zig-api-surface.zig).
    const args = try init.minimal.args.toSlice(init.arena.allocator());
    if (args.len < 2) {
        try printErr(io, "usage: zig-doc-coverage <path-to.zig>\n");
        return 2;
    }
    const path = args[1];

    // Bounded read: a tampered/unbounded file cannot OOM the scanner
    // (same hardening as scripts/emit-sbom.zig).
    const source = std.Io.Dir.cwd().readFileAlloc(io, path, gpa, .limited(max_source_bytes)) catch |err| {
        try printErrFmt(io, "cannot read {s}: {s}\n", .{ path, @errorName(err) });
        return 1;
    };
    defer gpa.free(source);

    const source_z = try gpa.dupeZ(u8, source);
    defer gpa.free(source_z);

    var ast = std.zig.Ast.parse(gpa, source_z, .zig) catch |err| {
        try printErrFmt(io, "cannot parse {s}: {s}\n", .{ path, @errorName(err) });
        return 1;
    };
    defer ast.deinit(gpa);

    if (ast.errors.len > 0) {
        // A syntactically broken file is not this gate's job to diagnose —
        // ast-check / the build owns that — but we must not silently pass
        // it as "fully documented". Fail loudly and defer to the real gate.
        try printErrFmt(io, "{s}: parse errors; run `zig ast-check` first\n", .{path});
        return 1;
    }

    var err_buf: [4096]u8 = undefined;
    var stderr_w = std.Io.File.stderr().writerStreaming(io, &err_buf);
    const w = &stderr_w.interface;

    const token_tags = ast.tokens.items(.tag);
    var undocumented: usize = 0;

    for (ast.rootDecls()) |decl_idx| {
        const decl = classifyPubDecl(ast, decl_idx) orelse continue; // non-pub skipped
        if (decl.is_main) continue; // sanctioned §1.2 / entrypoint exception
        if (isDocumented(ast, token_tags, decl_idx)) continue;

        const line = lineOf(source, tokenStart(ast, ast.firstToken(decl_idx)));
        try w.print(
            "{s}:{d}: undocumented pub {s} '{s}'\n",
            .{ path, line, decl.kind, decl.name },
        );
        undocumented += 1;
    }

    if (undocumented > 0) {
        try w.print(
            "doc-coverage: {d} undocumented public declaration(s) in {s} (TIGER_STYLE_ZIG §10)\n",
            .{ undocumented, path },
        );
        try w.flush();
        return 1;
    }
    try w.flush();
    return 0;
}

const PubDecl = struct {
    name: []const u8,
    kind: []const u8,
    is_main: bool,
};

/// Classify a top-level decl, returning it only when it is `pub`. Mirrors
/// scripts/zig-api-surface.zig#classifyDecl so the two tools agree on what
/// "the public surface" is. The 0.14/0.15 namespace-merge keyword was
/// removed in 0.15.1, so only fn and var/const decl tags are handled.
fn classifyPubDecl(ast: std.zig.Ast, decl_idx: std.zig.Ast.Node.Index) ?PubDecl {
    const tags = ast.nodes.items(.tag);
    const main_tokens = ast.nodes.items(.main_token);
    const token_tags = ast.tokens.items(.tag);

    switch (tags[@intFromEnum(decl_idx)]) {
        .fn_decl,
        .fn_proto_simple,
        .fn_proto_multi,
        .fn_proto_one,
        .fn_proto,
        => {
            const main_tok = main_tokens[@intFromEnum(decl_idx)];
            if (!hasPubBefore(token_tags, main_tok)) return null;
            const name_tok = findFnNameToken(ast, decl_idx) orelse return null;
            const name = ast.tokenSlice(name_tok);
            return .{ .name = name, .kind = "fn", .is_main = std.mem.eql(u8, name, "main") };
        },
        .simple_var_decl,
        .local_var_decl,
        .global_var_decl,
        .aligned_var_decl,
        => {
            const main_tok = main_tokens[@intFromEnum(decl_idx)];
            if (!hasPubBefore(token_tags, main_tok)) return null;
            const kind: []const u8 = if (token_tags[main_tok] == .keyword_const) "const" else "var";
            const name_tok = main_tok + 1;
            if (name_tok >= token_tags.len) return null;
            if (token_tags[name_tok] != .identifier) return null;
            return .{ .name = ast.tokenSlice(name_tok), .kind = kind, .is_main = false };
        },
        else => return null,
    }
}

/// A pub decl is documented iff a `.doc_comment` token sits immediately
/// before its first token. `ast.firstToken(decl)` for a pub decl is the
/// `keyword_pub` token, and Zig requires the `///` to precede `pub`, so the
/// doc-comment token (if any) is exactly at `firstToken - 1`.
fn isDocumented(
    ast: std.zig.Ast,
    token_tags: []const std.zig.Token.Tag,
    decl_idx: std.zig.Ast.Node.Index,
) bool {
    const first = ast.firstToken(decl_idx);
    if (first == 0) return false;
    return token_tags[first - 1] == .doc_comment;
}

/// Returns true if the nearest non-doc-comment token before `tok` is `pub`.
/// Identical to scripts/zig-api-surface.zig#hasPubBefore.
fn hasPubBefore(token_tags: []const std.zig.Token.Tag, tok: std.zig.Ast.TokenIndex) bool {
    if (tok == 0) return false;
    var i: usize = tok;
    while (i > 0) {
        i -= 1;
        switch (token_tags[i]) {
            .keyword_pub => return true,
            .doc_comment, .container_doc_comment => continue,
            else => return false,
        }
    }
    return false;
}

/// Locate the identifier token naming a function decl.
fn findFnNameToken(ast: std.zig.Ast, decl_idx: std.zig.Ast.Node.Index) ?std.zig.Ast.TokenIndex {
    const main_tok = ast.nodes.items(.main_token)[@intFromEnum(decl_idx)];
    const token_tags = ast.tokens.items(.tag);
    var i: usize = main_tok;
    const end = @min(i + 4, token_tags.len);
    while (i < end) : (i += 1) {
        if (token_tags[i] == .identifier) return @intCast(i);
    }
    return null;
}

/// Byte offset where `tok` begins in the source.
fn tokenStart(ast: std.zig.Ast, tok: std.zig.Ast.TokenIndex) usize {
    return ast.tokens.items(.start)[tok];
}

/// 1-based line number of byte offset `pos`.
fn lineOf(source: []const u8, pos: usize) usize {
    var line: usize = 1;
    var i: usize = 0;
    const end = @min(pos, source.len);
    while (i < end) : (i += 1) {
        if (source[i] == '\n') line += 1;
    }
    return line;
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

test "isDocumented detects /// before pub and rejects plain // and missing" {
    const gpa = std.testing.allocator;
    const src =
        \\//! container doc
        \\const std = @import("std");
        \\/// documented fn
        \\pub fn foo() void {}
        \\pub fn bar() void {}
        \\/// documented const
        \\pub const X = 1;
        \\// plain comment, not a doc comment
        \\pub const Y = 2;
        \\
    ;
    const srcz = try gpa.dupeZ(u8, src);
    defer gpa.free(srcz);
    var ast = try std.zig.Ast.parse(gpa, srcz, .zig);
    defer ast.deinit(gpa);
    try std.testing.expectEqual(@as(usize, 0), ast.errors.len);

    const token_tags = ast.tokens.items(.tag);
    var documented: usize = 0;
    var undocumented: usize = 0;
    for (ast.rootDecls()) |d| {
        const decl = classifyPubDecl(ast, d) orelse continue;
        if (decl.is_main) continue;
        if (isDocumented(ast, token_tags, d)) documented += 1 else undocumented += 1;
    }
    // foo + X are documented; bar + Y are not.
    try std.testing.expectEqual(@as(usize, 2), documented);
    try std.testing.expectEqual(@as(usize, 2), undocumented);
}

test "pub fn main is exempt" {
    const gpa = std.testing.allocator;
    const src =
        \\pub fn main() void {}
        \\
    ;
    const srcz = try gpa.dupeZ(u8, src);
    defer gpa.free(srcz);
    var ast = try std.zig.Ast.parse(gpa, srcz, .zig);
    defer ast.deinit(gpa);
    const token_tags = ast.tokens.items(.tag);
    var undocumented: usize = 0;
    for (ast.rootDecls()) |d| {
        const decl = classifyPubDecl(ast, d) orelse continue;
        if (decl.is_main) continue;
        if (!isDocumented(ast, token_tags, d)) undocumented += 1;
    }
    // main is skipped, so an undocumented `pub fn main` is NOT a violation.
    try std.testing.expectEqual(@as(usize, 0), undocumented);
}
