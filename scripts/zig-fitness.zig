//! zig-fitness — architecture-fitness walker over `std.zig.Ast`.
//!
//! Scans every *.zig file under a directory and checks four cultural rules:
//!
//!   1. **Allocator propagation**: any `pub fn` that calls `.alloc(`,
//!      `.create(`, `.destroy(`, or `.free(` must have a parameter whose
//!      type spelling is `std.mem.Allocator` or `Allocator`.
//!   2. **Io injection**: any `pub fn` that references `std.Io.Threaded`,
//!      `std.Io.Evented`, `std.Io.Dir`, or `std.fs.cwd` directly must have
//!      a parameter whose type spelling is `std.Io` or `Io`.
//!   3. **No top-level `var`** outside `main.zig` and `build.zig`: global
//!      mutable state is a correctness smell.
//!   4. **Named error sets**: a `pub fn` whose return type begins with `!T`
//!      (inferred error set) is flagged as a warning.
//!
//! Output is NDJSON-ish: one JSON object per violation on stdout, followed
//! by a summary line. Non-zero exit if any violation fires.
//!
//! Usage:
//!   mise x zig@0.16.0 -- zig run scripts/zig-fitness.zig -- src
//!
//! This is a *token-level* walker, not a full semantic analyzer. It accepts
//! some false-negatives (e.g. allocators smuggled through a struct field)
//! in exchange for zero dependencies and sub-second runtimes.

const std = @import("std");

const Violation = struct {
    file: []const u8,
    kind: []const u8,
    line: usize,
    message: []const u8,
};

pub fn main(init: std.process.Init) !u8 {
    const gpa = init.gpa;
    const io = init.io;

    var arg_iter = std.process.Args.Iterator.init(init.minimal.args);
    _ = arg_iter.next(); // exe
    const dir_arg = arg_iter.next() orelse {
        try printErr(io, "usage: zig-fitness <dir>\n");
        return 2;
    };

    var out_buf: [8192]u8 = undefined;
    var stdout_w = std.Io.File.stdout().writerStreaming(io, &out_buf);
    const w = &stdout_w.interface;

    var violation_count: usize = 0;

    var stack = std.array_list.Managed([]u8).init(gpa);
    defer {
        for (stack.items) |p| gpa.free(p);
        stack.deinit();
    }
    try stack.append(try gpa.dupe(u8, dir_arg));

    while (stack.pop()) |current| {
        defer gpa.free(current);

        var dir = std.Io.Dir.cwd().openDir(io, current, .{ .iterate = true }) catch |err| switch (err) {
            error.NotDir, error.FileNotFound => continue,
            else => return err,
        };
        defer dir.close(io);

        var it = dir.iterate();
        while (try it.next(io)) |entry| {
            const joined = try std.fs.path.join(gpa, &.{ current, entry.name });
            switch (entry.kind) {
                .directory => try stack.append(joined),
                .file => {
                    defer gpa.free(joined);
                    if (!std.mem.endsWith(u8, entry.name, ".zig")) continue;
                    violation_count += try scanFile(gpa, io, joined, w);
                },
                else => gpa.free(joined),
            }
        }
    }

    try w.print("{{\"summary\": {{\"violations\": {d}}}}}\n", .{violation_count});
    try w.flush();
    return if (violation_count == 0) 0 else 1;
}

/// Scan a single .zig file and emit JSON violations to `w`.
/// Returns the number of violations emitted.
fn scanFile(
    gpa: std.mem.Allocator,
    io: std.Io,
    path: []const u8,
    w: *std.Io.Writer,
) !usize {
    const source = std.Io.Dir.cwd().readFileAlloc(io, path, gpa, .unlimited) catch |err| {
        try printErrFmt(io, "cannot read {s}: {s}\n", .{ path, @errorName(err) });
        return 0;
    };
    defer gpa.free(source);

    const source_z = try gpa.dupeZ(u8, source);
    defer gpa.free(source_z);

    var ast = try std.zig.Ast.parse(gpa, source_z, .zig);
    defer ast.deinit(gpa);
    if (ast.errors.len > 0) return 0;

    const base = std.fs.path.basename(path);
    const allow_top_var = std.mem.eql(u8, base, "main.zig") or std.mem.eql(u8, base, "build.zig");

    var count: usize = 0;
    const tags = ast.nodes.items(.tag);
    const main_tokens = ast.nodes.items(.main_token);
    const token_tags = ast.tokens.items(.tag);

    for (ast.rootDecls()) |decl_idx| {
        const tag = tags[@intFromEnum(decl_idx)];
        switch (tag) {
            .simple_var_decl, .global_var_decl, .aligned_var_decl => {
                const main_tok = main_tokens[@intFromEnum(decl_idx)];
                if (token_tags[main_tok] == .keyword_var and !allow_top_var) {
                    const line = lineOf(source, spanStart(ast, decl_idx));
                    try emit(w, .{
                        .file = path,
                        .kind = "top-level-var",
                        .line = line,
                        .message = "top-level `var` outside main.zig / build.zig",
                    });
                    count += 1;
                }
            },
            .fn_decl => {
                if (!isPubFn(token_tags, main_tokens[@intFromEnum(decl_idx)])) continue;
                const span = ast.nodeToSpan(decl_idx);
                const body = source[span.start..span.end];
                const name_tok = findFnNameToken(ast, decl_idx) orelse continue;
                const name = ast.tokenSlice(name_tok);
                const line = lineOf(source, span.start);

                const allocates = containsAny(body, &.{ ".alloc(", ".create(", ".destroy(", ".free(", "allocPrint(", ".dupe(" });
                const has_alloc_param = containsAny(body, &.{ "std.mem.Allocator", ": Allocator", ":Allocator" });
                if (allocates and !has_alloc_param) {
                    try emitFmt(w, gpa, .{
                        .file = path,
                        .kind = "alloc-propagation",
                        .line = line,
                        .message_fmt = "pub fn `{s}` allocates but takes no std.mem.Allocator parameter",
                        .message_arg = name,
                    });
                    count += 1;
                }

                const touches_io = containsAny(body, &.{
                    "std.Io.Threaded",
                    "std.Io.Evented",
                    "std.Io.Dir",
                    "std.Io.File",
                    "std.fs.cwd",
                });
                const has_io_param = containsAny(body, &.{ ": std.Io", ":std.Io", ": Io", ":Io" });
                if (touches_io and !has_io_param) {
                    try emitFmt(w, gpa, .{
                        .file = path,
                        .kind = "io-injection",
                        .line = line,
                        .message_fmt = "pub fn `{s}` uses std.Io.* or std.fs.cwd but takes no std.Io parameter",
                        .message_arg = name,
                    });
                    count += 1;
                }

                // Inferred error set detection: look for `!` in the return
                // position without a preceding named-set identifier.
                if (hasInferredErrorSet(body)) {
                    try emitFmt(w, gpa, .{
                        .file = path,
                        .kind = "inferred-error-set",
                        .line = line,
                        .message_fmt = "pub fn `{s}` returns `!T` with inferred error set; prefer a named set",
                        .message_arg = name,
                    });
                    count += 1;
                }
            },
            else => {},
        }
    }
    return count;
}

fn isPubFn(token_tags: []const std.zig.Token.Tag, fn_tok: std.zig.Ast.TokenIndex) bool {
    if (fn_tok == 0) return false;
    var i: usize = @as(usize, fn_tok);
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

fn findFnNameToken(ast: std.zig.Ast, decl_idx: std.zig.Ast.Node.Index) ?std.zig.Ast.TokenIndex {
    const main_tok = ast.nodes.items(.main_token)[@intFromEnum(decl_idx)];
    const token_tags = ast.tokens.items(.tag);
    var i: usize = @as(usize, main_tok);
    const end = @min(i + 4, token_tags.len);
    while (i < end) : (i += 1) {
        if (token_tags[i] == .identifier) return @intCast(i);
    }
    return null;
}

fn containsAny(haystack: []const u8, needles: []const []const u8) bool {
    for (needles) |n| {
        if (std.mem.indexOf(u8, haystack, n) != null) return true;
    }
    return false;
}

/// Heuristic: scan the function signature for a lonely `!` followed by an
/// identifier/type without a preceding named set.
fn hasInferredErrorSet(body: []const u8) bool {
    // Find the first ')' after `fn (` — that closes the parameter list.
    const close_paren = std.mem.indexOfScalar(u8, body, ')') orelse return false;
    // Walk from close_paren to the '{' that opens the body.
    const open_brace = std.mem.indexOfScalar(u8, body[close_paren..], '{') orelse return false;
    const sig = body[close_paren .. close_paren + open_brace];
    const bang = std.mem.indexOfScalar(u8, sig, '!') orelse return false;
    // If the char immediately before `!` is alphanumeric / underscore, it's
    // a named set (e.g. `HelloError!T`). If it's whitespace, it's inferred.
    if (bang == 0) return true;
    const prev = sig[bang - 1];
    return std.ascii.isWhitespace(prev) or prev == ')';
}

fn spanStart(ast: std.zig.Ast, decl_idx: std.zig.Ast.Node.Index) usize {
    return ast.nodeToSpan(decl_idx).start;
}

fn lineOf(source: []const u8, offset: usize) usize {
    var line: usize = 1;
    var i: usize = 0;
    while (i < offset and i < source.len) : (i += 1) {
        if (source[i] == '\n') line += 1;
    }
    return line;
}

const EmitArgs = struct {
    file: []const u8,
    kind: []const u8,
    line: usize,
    message: []const u8,
};

fn emit(w: *std.Io.Writer, args: EmitArgs) !void {
    try w.print(
        "{{\"file\":\"{s}\",\"kind\":\"{s}\",\"line\":{d},\"message\":\"{s}\"}}\n",
        .{ args.file, args.kind, args.line, args.message },
    );
}

const EmitFmtArgs = struct {
    file: []const u8,
    kind: []const u8,
    line: usize,
    message_fmt: []const u8,
    message_arg: []const u8,
};

fn emitFmt(w: *std.Io.Writer, gpa: std.mem.Allocator, args: EmitFmtArgs) !void {
    const msg = try std.fmt.allocPrint(gpa, "{s}", .{args.message_fmt});
    defer gpa.free(msg);
    // Replace {s} with the arg (very small-scope formatter).
    const replaced = try std.mem.replaceOwned(u8, gpa, msg, "{s}", args.message_arg);
    defer gpa.free(replaced);
    try w.print(
        "{{\"file\":\"{s}\",\"kind\":\"{s}\",\"line\":{d},\"message\":\"{s}\"}}\n",
        .{ args.file, args.kind, args.line, replaced },
    );
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
