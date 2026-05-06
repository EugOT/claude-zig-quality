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
///
/// Read-error policy: any read error other than `error.FileNotFound`
/// (vanished mid-walk, harmless) emits a `read-error` violation and
/// counts as one violation so the gate fails closed. In particular,
/// `error.FileTooBig` from the 1 MiB cap is **not** silently skipped:
/// an attacker who plants a 2 MiB Zig source must not bypass every
/// downstream check by exceeding the cap.
fn scanFile(
    gpa: std.mem.Allocator,
    io: std.Io,
    path: []const u8,
    w: *std.Io.Writer,
) !usize {
    // Prevent OOM from tampered files
    const source = std.Io.Dir.cwd().readFileAlloc(io, path, gpa, .limited(1 << 20)) catch |err| switch (err) {
        error.FileNotFound => {
            // The file disappeared between iterate() and readFileAlloc().
            // That is benign: the directory walker raced against another
            // process. Skipping is correct.
            try printErrFmt(io, "cannot read {s}: {s}\n", .{ path, @errorName(err) });
            return 0;
        },
        else => {
            // Every other read error is treated as a fitness violation
            // so the gate exits non-zero. Critically this includes
            // `error.FileTooBig` from the 1 MiB cap, which would
            // otherwise let a 2 MiB Zig source bypass every check.
            try printErrFmt(io, "cannot read {s}: {s}\n", .{ path, @errorName(err) });
            try emitFmt(w, gpa, .{
                .file = path,
                .kind = "read-error",
                .line = 1,
                .message_fmt = "could not read source file: {s}",
                .message_arg = @errorName(err),
            });
            return 1;
        },
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
                    try emit(w, gpa, .{
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
///
/// Caveats — this is an intentional, speed-oriented best-effort heuristic
/// for the per-commit fitness gate, not a full AST analysis:
///   (a) False positives: a `!` inside a string literal (e.g. `"hi!"`) or
///       a default parameter value will be misread as an inferred error
///       set marker.
///   (b) The walker assumes the *first* `)` closes the parameter list and
///       the *first* subsequent `{` opens the body. Complex signatures
///       (nested fn types in params, struct literal defaults containing
///       `)` or `{`, multi-line return types) can fool both anchors.
///   (c) We accept these false positives because the alternative — a full
///       AST traversal of every fn_proto — pushes the gate above its
///       sub-second budget. Reviewers can suppress noise case-by-case.
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

/// Emit one NDJSON violation record. Every interpolated string field
/// (`file`, `kind`, `message`) is JSON-escaped before interpolation so a
/// filename that contains `"` or `\n` cannot corrupt the NDJSON stream
/// consumed downstream by `zig-fitness-report.ts`.
fn emit(w: *std.Io.Writer, gpa: std.mem.Allocator, args: EmitArgs) !void {
    const file_esc = try escapeJsonString(gpa, args.file);
    defer gpa.free(file_esc);
    const kind_esc = try escapeJsonString(gpa, args.kind);
    defer gpa.free(kind_esc);
    const message_esc = try escapeJsonString(gpa, args.message);
    defer gpa.free(message_esc);
    try w.print(
        "{{\"file\":\"{s}\",\"kind\":\"{s}\",\"line\":{d},\"message\":\"{s}\"}}\n",
        .{ file_esc, kind_esc, args.line, message_esc },
    );
}

const EmitFmtArgs = struct {
    file: []const u8,
    kind: []const u8,
    line: usize,
    message_fmt: []const u8,
    message_arg: []const u8,
};

/// Emit one NDJSON violation record built from a `{s}`-style template.
/// `file`, `kind`, and the rendered message all flow through
/// `escapeJsonString` before they reach the wire.
fn emitFmt(w: *std.Io.Writer, gpa: std.mem.Allocator, args: EmitFmtArgs) !void {
    const msg = try std.fmt.allocPrint(gpa, "{s}", .{args.message_fmt});
    defer gpa.free(msg);
    // Replace {s} with the arg (very small-scope formatter).
    const replaced = try std.mem.replaceOwned(u8, gpa, msg, "{s}", args.message_arg);
    defer gpa.free(replaced);
    // Escape every interpolated field so embedded quotes, backslashes,
    // or control chars in `file`/`kind`/`message` never break the
    // surrounding NDJSON envelope.
    const file_esc = try escapeJsonString(gpa, args.file);
    defer gpa.free(file_esc);
    const kind_esc = try escapeJsonString(gpa, args.kind);
    defer gpa.free(kind_esc);
    const escaped_message = try escapeJsonString(gpa, replaced);
    defer gpa.free(escaped_message);
    const line = try std.fmt.allocPrint(
        gpa,
        "{{\"file\":\"{s}\",\"kind\":\"{s}\",\"line\":{d},\"message\":\"{s}\"}}\n",
        .{ file_esc, kind_esc, args.line, escaped_message },
    );
    defer gpa.free(line);
    try w.writeAll(line);
}

/// JSON-escape `s` per RFC 8259 §7. Escapes `"`, `\`, and the control
/// characters `\n`/`\r`/`\t`/`\b`/`\f` plus any remaining byte in the
/// `\u{0000}`-`\u{001F}` range as `\uXXXX`. Caller owns the returned slice.
fn escapeJsonString(gpa: std.mem.Allocator, s: []const u8) ![]u8 {
    var buf: std.array_list.Managed(u8) = std.array_list.Managed(u8).init(gpa);
    errdefer buf.deinit();
    for (s) |c| {
        switch (c) {
            '"' => try buf.appendSlice("\\\""),
            '\\' => try buf.appendSlice("\\\\"),
            '\n' => try buf.appendSlice("\\n"),
            '\r' => try buf.appendSlice("\\r"),
            '\t' => try buf.appendSlice("\\t"),
            0x08 => try buf.appendSlice("\\b"),
            0x0C => try buf.appendSlice("\\f"),
            0x00...0x07, 0x0B, 0x0E...0x1F => {
                const hex_digits = "0123456789abcdef";
                try buf.appendSlice("\\u00");
                try buf.append(hex_digits[(c >> 4) & 0xF]);
                try buf.append(hex_digits[c & 0xF]);
            },
            else => try buf.append(c),
        }
    }
    return buf.toOwnedSlice();
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

test "scanFile reports oversized files as a violation rather than skipping" {
    // Regression test for fix 2.6z: an attacker who plants a 2 MiB Zig
    // source must not bypass the fitness gate. `error.FileTooBig` from
    // the 1 MiB cap has to surface as a `read-error` violation with a
    // non-zero count, not a silent zero.
    const gpa = std.testing.allocator;

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    // 2 MiB of valid Zig token bytes — we never parse it, the read cap
    // fires first.
    const big_size: usize = 2 * (1 << 20);
    const big_payload = try gpa.alloc(u8, big_size);
    defer gpa.free(big_payload);
    @memset(big_payload, '/'); // any byte is fine; we never parse it.

    try tmp.dir.writeFile(std.testing.io, .{
        .sub_path = "huge.zig",
        .data = big_payload,
    });

    const rel_path = try std.fs.path.join(gpa, &.{
        ".zig-cache", "tmp", &tmp.sub_path, "huge.zig",
    });
    defer gpa.free(rel_path);

    var out_buf: [4096]u8 = undefined;
    var w: std.Io.Writer = .fixed(&out_buf);

    const violations = try scanFile(gpa, std.testing.io, rel_path, &w);
    try std.testing.expectEqual(@as(usize, 1), violations);

    const written = w.buffered();
    try std.testing.expect(std.mem.indexOf(u8, written, "\"kind\":\"read-error\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, written, "huge.zig") != null);
}

test "emit JSON-escapes filenames so quotes and newlines cannot break NDJSON" {
    // Regression test for fix 2.7z: filenames with `"` or `\n` must be
    // escaped before they reach the wire, otherwise the NDJSON line
    // parses as malformed and downstream consumers crash.
    const gpa = std.testing.allocator;
    const evil_file = "evil\"name\nwith\\newline.zig";
    const evil_kind = "kind\"with\"quotes";

    var out_buf: [1024]u8 = undefined;
    var w: std.Io.Writer = .fixed(&out_buf);

    try emit(&w, gpa, .{
        .file = evil_file,
        .kind = evil_kind,
        .line = 7,
        .message = "ok",
    });
    const written = w.buffered();

    // The raw `"` from the filename must not appear unescaped — every
    // quote in the payload should be `\"`. The literal backslash before
    // `newline` in the source must be doubled to `\\` on the wire.
    try std.testing.expect(std.mem.indexOf(u8, written, "evil\\\"name") != null);
    try std.testing.expect(std.mem.indexOf(u8, written, "with\\\\newline") != null);
    try std.testing.expect(std.mem.indexOf(u8, written, "\\n") != null);
    try std.testing.expect(std.mem.indexOf(u8, written, "kind\\\"with\\\"quotes") != null);
    // And the literal raw newline byte must not survive escaping into
    // the rendered line.
    try std.testing.expect(std.mem.indexOf(u8, written, "evil\"name\nwith") == null);
}

test "emitFmt JSON-escapes file and kind too" {
    // Regression test for fix 2.7z (emitFmt branch).
    const gpa = std.testing.allocator;

    var out_buf: [1024]u8 = undefined;
    var w: std.Io.Writer = .fixed(&out_buf);

    try emitFmt(&w, gpa, .{
        .file = "weird\"file.zig",
        .kind = "weird\\kind",
        .line = 3,
        .message_fmt = "hello {s}",
        .message_arg = "world",
    });
    const written = w.buffered();
    try std.testing.expect(std.mem.indexOf(u8, written, "weird\\\"file.zig") != null);
    try std.testing.expect(std.mem.indexOf(u8, written, "weird\\\\kind") != null);
}

test "escapeJsonString covers every control-character class" {
    // Audit pass for fix 2.10: every escape branch is exercised in one
    // test so a regression in any single class is caught.
    const gpa = std.testing.allocator;
    const input = "\"\\\n\r\t\x08\x0C\x01\x1F";
    const escaped = try escapeJsonString(gpa, input);
    defer gpa.free(escaped);

    try std.testing.expectEqualStrings(
        "\\\"\\\\\\n\\r\\t\\b\\f\\u0001\\u001f",
        escaped,
    );
}
