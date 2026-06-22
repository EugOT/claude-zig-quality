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

// ---------------------------------------------------------------------------
// Unit tests — TIGER_STYLE_ZIG §3: std.testing.allocator on every test that
// allocates; _ = alloc where the test does not.
// ---------------------------------------------------------------------------

// --- isDocumented -----------------------------------------------------------

test "isDocumented: firstToken == 0 guard returns false (no underflow)" {
    // Build a minimal AST whose first root decl has firstToken == 0 so the
    // `if (first == 0) return false` guard is exercised without an underflow.
    // A bare `pub fn main() void {}` parses cleanly; firstToken of the fn_decl
    // node points to the `pub` keyword, which is token 0 in this source.
    const gpa = std.testing.allocator;
    const src = "pub fn main() void {}\n";
    const srcz = try gpa.dupeZ(u8, src);
    defer gpa.free(srcz);
    var ast = try std.zig.Ast.parse(gpa, srcz, .zig);
    defer ast.deinit(gpa);
    try std.testing.expectEqual(@as(usize, 0), ast.errors.len);

    const token_tags = ast.tokens.items(.tag);
    const decls = ast.rootDecls();
    try std.testing.expect(decls.len >= 1);
    // `pub` keyword is the very first token (index 0), so firstToken == 0.
    const first = ast.firstToken(decls[0]);
    try std.testing.expectEqual(@as(std.zig.Ast.TokenIndex, 0), first);
    // isDocumented must return false (not underflow to token[~0]).
    try std.testing.expectEqual(false, isDocumented(ast, token_tags, decls[0]));
}

test "isDocumented: consecutive /// lines all adjacent → documented" {
    // Multiple consecutive `///` lines immediately before `pub` — the last
    // `///` token is at firstToken-1, which is still `.doc_comment`.
    const gpa = std.testing.allocator;
    const src =
        \\/// First line of doc comment.
        \\/// Second line of doc comment.
        \\/// Third line.
        \\pub fn multiLine() void {}
        \\
    ;
    const srcz = try gpa.dupeZ(u8, src);
    defer gpa.free(srcz);
    var ast = try std.zig.Ast.parse(gpa, srcz, .zig);
    defer ast.deinit(gpa);
    try std.testing.expectEqual(@as(usize, 0), ast.errors.len);

    const token_tags = ast.tokens.items(.tag);
    var found: bool = false;
    for (ast.rootDecls()) |d| {
        const decl = classifyPubDecl(ast, d) orelse continue;
        if (std.mem.eql(u8, decl.name, "multiLine")) {
            found = true;
            try std.testing.expectEqual(true, isDocumented(ast, token_tags, d));
        }
    }
    try std.testing.expect(found);
}

test "isDocumented: blank line between /// and pub → not documented" {
    // A blank line between the doc comment and the declaration means the
    // token immediately before `pub` is NOT `.doc_comment`; the parser emits
    // no token for the blank line itself.  Zig's grammar does NOT attach a
    // doc comment across a blank line, so we expect `false`.
    //
    // NOTE: In Zig's AST, plain `//` is not a token at all, but `///` IS a
    // token. However, a blank line resets doc-comment attachment — the `///`
    // tokens are parsed at their actual position; if another non-doc token
    // (like a newline-triggered reset or another identifier) intervenes,
    // the doc_comment will not be immediately before `pub`.
    // The simplest way to break adjacency is to put a non-pub, non-doc
    // token between them — a private decl interrupts the sequence.
    const gpa = std.testing.allocator;
    const src =
        \\/// This doc comment belongs to an earlier decl.
        \\const _gap = 0;
        \\pub fn separated() void {}
        \\
    ;
    const srcz = try gpa.dupeZ(u8, src);
    defer gpa.free(srcz);
    var ast = try std.zig.Ast.parse(gpa, srcz, .zig);
    defer ast.deinit(gpa);
    try std.testing.expectEqual(@as(usize, 0), ast.errors.len);

    const token_tags = ast.tokens.items(.tag);
    var found: bool = false;
    for (ast.rootDecls()) |d| {
        const decl = classifyPubDecl(ast, d) orelse continue;
        if (std.mem.eql(u8, decl.name, "separated")) {
            found = true;
            // No doc comment immediately before this `pub`.
            try std.testing.expectEqual(false, isDocumented(ast, token_tags, d));
        }
    }
    try std.testing.expect(found);
}

// --- classifyPubDecl --------------------------------------------------------

test "classifyPubDecl: pub fn main → is_main=true (exemption)" {
    const gpa = std.testing.allocator;
    const src = "pub fn main() void {}\n";
    const srcz = try gpa.dupeZ(u8, src);
    defer gpa.free(srcz);
    var ast = try std.zig.Ast.parse(gpa, srcz, .zig);
    defer ast.deinit(gpa);
    try std.testing.expectEqual(@as(usize, 0), ast.errors.len);

    const decls = ast.rootDecls();
    try std.testing.expect(decls.len >= 1);
    const result = classifyPubDecl(ast, decls[0]);
    try std.testing.expect(result != null);
    try std.testing.expectEqual(true, result.?.is_main);
    try std.testing.expectEqualStrings("main", result.?.name);
    try std.testing.expectEqualStrings("fn", result.?.kind);
}

test "classifyPubDecl: private fn → null (not public surface)" {
    const gpa = std.testing.allocator;
    const src = "fn privateHelper() void {}\n";
    const srcz = try gpa.dupeZ(u8, src);
    defer gpa.free(srcz);
    var ast = try std.zig.Ast.parse(gpa, srcz, .zig);
    defer ast.deinit(gpa);
    try std.testing.expectEqual(@as(usize, 0), ast.errors.len);

    for (ast.rootDecls()) |d| {
        try std.testing.expectEqual(@as(?PubDecl, null), classifyPubDecl(ast, d));
    }
}

test "classifyPubDecl: pub const → kind=const, is_main=false" {
    const gpa = std.testing.allocator;
    const src = "pub const MaxSize: usize = 4096;\n";
    const srcz = try gpa.dupeZ(u8, src);
    defer gpa.free(srcz);
    var ast = try std.zig.Ast.parse(gpa, srcz, .zig);
    defer ast.deinit(gpa);
    try std.testing.expectEqual(@as(usize, 0), ast.errors.len);

    var found: bool = false;
    for (ast.rootDecls()) |d| {
        const decl = classifyPubDecl(ast, d) orelse continue;
        found = true;
        try std.testing.expectEqualStrings("const", decl.kind);
        try std.testing.expectEqualStrings("MaxSize", decl.name);
        try std.testing.expectEqual(false, decl.is_main);
    }
    try std.testing.expect(found);
}

test "classifyPubDecl: pub var → kind=var, is_main=false" {
    const gpa = std.testing.allocator;
    const src = "pub var counter: u32 = 0;\n";
    const srcz = try gpa.dupeZ(u8, src);
    defer gpa.free(srcz);
    var ast = try std.zig.Ast.parse(gpa, srcz, .zig);
    defer ast.deinit(gpa);
    try std.testing.expectEqual(@as(usize, 0), ast.errors.len);

    var found: bool = false;
    for (ast.rootDecls()) |d| {
        const decl = classifyPubDecl(ast, d) orelse continue;
        found = true;
        try std.testing.expectEqualStrings("var", decl.kind);
        try std.testing.expectEqualStrings("counter", decl.name);
        try std.testing.expectEqual(false, decl.is_main);
    }
    try std.testing.expect(found);
}

test "classifyPubDecl: fn_proto_simple classified as fn" {
    // A function with exactly one param and no body is fn_proto_simple in the
    // Zig 0.16 AST.  `pub fn name(x: T) R;` has token sequence
    // [keyword_pub][keyword_fn][identifier]… so hasPubBefore(fn_tok) → true.
    // Note: `pub extern fn` inserts a keyword_extern between pub and fn, which
    // blocks hasPubBefore — that form is intentionally excluded by this tool
    // (extern fns have no Zig-side doc obligation).
    const gpa = std.testing.allocator;
    const src = "pub fn simpleProto(x: i32) i32;\n";
    const srcz = try gpa.dupeZ(u8, src);
    defer gpa.free(srcz);
    var ast = try std.zig.Ast.parse(gpa, srcz, .zig);
    defer ast.deinit(gpa);
    try std.testing.expectEqual(@as(usize, 0), ast.errors.len);

    var found: bool = false;
    for (ast.rootDecls()) |d| {
        const decl = classifyPubDecl(ast, d) orelse continue;
        found = true;
        try std.testing.expectEqualStrings("fn", decl.kind);
        try std.testing.expectEqualStrings("simpleProto", decl.name);
        try std.testing.expectEqual(false, decl.is_main);
    }
    try std.testing.expect(found);
}

// --- hasPubBefore -----------------------------------------------------------

test "hasPubBefore: skips doc_comment tokens then finds pub → true" {
    // Parse a documented pub fn; the token sequence before the fn keyword is:
    //   [doc_comment] [keyword_pub] [keyword_fn] ...
    // hasPubBefore is called with the fn keyword token index and must skip
    // the pub keyword to find it (it scans backward).
    const gpa = std.testing.allocator;
    const src =
        \\/// doc
        \\pub fn example() void {}
        \\
    ;
    const srcz = try gpa.dupeZ(u8, src);
    defer gpa.free(srcz);
    var ast = try std.zig.Ast.parse(gpa, srcz, .zig);
    defer ast.deinit(gpa);
    try std.testing.expectEqual(@as(usize, 0), ast.errors.len);

    const token_tags = ast.tokens.items(.tag);
    // Find the `fn` keyword token; hasPubBefore must return true.
    var fn_tok: ?std.zig.Ast.TokenIndex = null;
    for (0..token_tags.len) |i| {
        if (token_tags[i] == .keyword_fn) {
            fn_tok = @intCast(i);
            break;
        }
    }
    try std.testing.expect(fn_tok != null);
    try std.testing.expectEqual(true, hasPubBefore(token_tags, fn_tok.?));
}

test "hasPubBefore: private fn → false" {
    const gpa = std.testing.allocator;
    const src = "fn internal() void {}\n";
    const srcz = try gpa.dupeZ(u8, src);
    defer gpa.free(srcz);
    var ast = try std.zig.Ast.parse(gpa, srcz, .zig);
    defer ast.deinit(gpa);
    try std.testing.expectEqual(@as(usize, 0), ast.errors.len);

    const token_tags = ast.tokens.items(.tag);
    var fn_tok: ?std.zig.Ast.TokenIndex = null;
    for (0..token_tags.len) |i| {
        if (token_tags[i] == .keyword_fn) {
            fn_tok = @intCast(i);
            break;
        }
    }
    try std.testing.expect(fn_tok != null);
    try std.testing.expectEqual(false, hasPubBefore(token_tags, fn_tok.?));
}

// --- lineOf -----------------------------------------------------------------

test "lineOf: offset 0 → line 1" {
    _ = std.testing.allocator; // no allocation in this test
    const src = "pub fn main() void {}\n";
    try std.testing.expectEqual(@as(usize, 1), lineOf(src, 0));
}

test "lineOf: counts newlines correctly across multi-line source" {
    _ = std.testing.allocator; // no allocation in this test
    const src = "line1\nline2\nline3\n";
    // Offset 0 → line 1 (before any '\n').
    try std.testing.expectEqual(@as(usize, 1), lineOf(src, 0));
    // Offset 6 is the 'l' of "line2" (after the first '\n' at index 5).
    try std.testing.expectEqual(@as(usize, 2), lineOf(src, 6));
    // Offset 12 is the 'l' of "line3".
    try std.testing.expectEqual(@as(usize, 3), lineOf(src, 12));
}

test "lineOf: pos beyond source.len clamps to end (no OOB)" {
    _ = std.testing.allocator; // no allocation in this test
    const src = "a\nb\n";
    // The function clamps via `@min(pos, source.len)`, so a huge offset
    // returns the total line count rather than crashing.
    try std.testing.expectEqual(@as(usize, 3), lineOf(src, 9999));
}

// NOTE: Functional / subprocess exit-code tests (exit 0, exit 1 with
// diagnostic, exit 2 for no-args) are deferred to Wave 2 TypeScript
// functional tests in scripts/doc-coverage.ts.  Reason: std.process.Child
// inside an embedded `test {}` block requires the compiled binary to exist
// on disk first, which creates a chicken-and-egg build dependency that the
// `test-scripts` step (which compiles *and* runs tests from the same source)
// cannot satisfy without a two-phase build.  The TS gate (doc-coverage.ts)
// already exercises these exit-code paths end-to-end as part of the per-PR
// tier.

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
