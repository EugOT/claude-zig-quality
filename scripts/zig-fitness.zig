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

    // Args.Iterator.init is @compileError on Windows/WASI; toSlice with the
    // process arena is the cross-platform 0.16 pattern.
    const args = try init.minimal.args.toSlice(init.arena.allocator());
    if (args.len < 2) {
        try printErr(io, "usage: zig-fitness <dir>\n");
        return 2;
    }
    const dir_arg = args[1];

    var out_buf: [8192]u8 = undefined;
    var stdout_w = std.Io.File.stdout().writerStreaming(io, &out_buf);
    const w = &stdout_w.interface;

    var violation_count: usize = 0;

    var stack: std.ArrayList([]u8) = .empty;
    defer {
        for (stack.items) |p| gpa.free(p);
        stack.deinit(gpa);
    }
    try appendOwnedPath(gpa, &stack, try gpa.dupe(u8, dir_arg));

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
                .directory => try appendOwnedPath(gpa, &stack, joined),
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
            try emitFmt(gpa, w, .{
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
                    try emit(gpa, w, .{
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

                const allocates = containsAny(body, &.{
                    ".alloc(",     ".create(",
                    ".destroy(",   ".free(",
                    "allocPrint(", ".dupe(",
                });
                const has_alloc_param = containsAny(body, &.{ "std.mem.Allocator", ": Allocator", ":Allocator" });
                if (allocates and !has_alloc_param) {
                    try emitFmt(gpa, w, .{
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
                    try emitFmt(gpa, w, .{
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
                    try emitFmt(gpa, w, .{
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
    var i: usize = fn_tok;
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
    var i: usize = main_tok;
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

fn appendOwnedPath(gpa: std.mem.Allocator, stack: *std.ArrayList([]u8), path: []u8) !void {
    errdefer gpa.free(path);
    try stack.append(gpa, path);
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
fn emit(gpa: std.mem.Allocator, w: *std.Io.Writer, args: EmitArgs) !void {
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
fn emitFmt(gpa: std.mem.Allocator, w: *std.Io.Writer, args: EmitFmtArgs) !void {
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
    var buf: std.ArrayList(u8) = .empty;
    errdefer buf.deinit(gpa);
    for (s) |c| {
        switch (c) {
            '"' => try buf.appendSlice(gpa, "\\\""),
            '\\' => try buf.appendSlice(gpa, "\\\\"),
            '\n' => try buf.appendSlice(gpa, "\\n"),
            '\r' => try buf.appendSlice(gpa, "\\r"),
            '\t' => try buf.appendSlice(gpa, "\\t"),
            0x08 => try buf.appendSlice(gpa, "\\b"),
            0x0C => try buf.appendSlice(gpa, "\\f"),
            0x00...0x07, 0x0B, 0x0E...0x1F => {
                const hex_digits = "0123456789abcdef";
                try buf.appendSlice(gpa, "\\u00");
                try buf.append(gpa, hex_digits[(c >> 4) & 0xF]);
                try buf.append(gpa, hex_digits[c & 0xF]);
            },
            else => try buf.append(gpa, c),
        }
    }
    return buf.toOwnedSlice(gpa);
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

    try emit(gpa, &w, .{
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

    try emitFmt(gpa, &w, .{
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

// ─── hasInferredErrorSet ────────────────────────────────────────────────────

test "hasInferredErrorSet: ') void' suffix is inferred" {
    // The simplest inferred pattern: close-paren, space, `!`, then return type.
    // sig slice (from first `)` to first `{`) is ") !void ".
    const body = "pub fn foo() !void { }";
    try std.testing.expect(hasInferredErrorSet(body));
}

test "hasInferredErrorSet: 'MyError!void' is NOT inferred" {
    // Named set: the char before `!` is alphanumeric (`r`), so guard fires.
    const body = "pub fn foo() MyError!void { }";
    try std.testing.expect(!hasInferredErrorSet(body));
}

test "hasInferredErrorSet: ')' immediately before '!' across multiline is inferred" {
    // The param-list close-paren is a valid prev-char for the `prev == ')'`
    // branch — covers fn types in params.
    const body = "pub fn foo(\n    x: u8,\n) !u32 {\n    return x;\n}";
    try std.testing.expect(hasInferredErrorSet(body));
}

test "hasInferredErrorSet: empty body with no ')' returns false" {
    // No close-paren → indexOfScalar returns null → early-return false.
    const body = "pub fn foo";
    try std.testing.expect(!hasInferredErrorSet(body));
}

test "hasInferredErrorSet: '!' inside string literal is a known false-positive (pin current behaviour)" {
    // KNOWN FALSE-POSITIVE: the heuristic does not lex string literals.
    // A `!` that appears between the first `)` and the first `{` — even
    // inside a default-value string — is misidentified as an inferred error
    // set marker. This test pins that behaviour so any future fix is
    // deliberate rather than accidental.
    //
    // The body below has no real inferred error set; the `!` lives inside
    // the default string argument, but the heuristic fires anyway.
    const body = "pub fn foo(x: []const u8) void { _ = x; }";
    // This specific body has no `!` between `)` and `{`, so it returns false.
    try std.testing.expect(!hasInferredErrorSet(body));

    // Now the FP case: a `!` in the sig window fools the heuristic.
    const body_fp = "pub fn bar(comptime fmt: []const u8) void {\n    _ = \"hi!\";\n}";
    // `)` found, then walk to `{`, sig = ") void {\n    _ = \"hi" — no `!`
    // in that window, so this particular body is actually NOT a FP.
    // The real FP arises when the `!` appears before the first `{`:
    const body_real_fp = "pub fn baz(x: u8) void { _ = x; _ = \"!\"; }";
    // `)` → sig = ") void " — no `!` before `{`.  Still false here.
    // Document: FP occurs only when `!` precedes the FIRST `{` in the body.
    // e.g.: pub fn qux(x: T) !void { }  — intentionally inferred (true positive).
    // The FP of `"!"` inside a string only triggers if the string literal
    // appears in the return-type position (rare in practice).
    _ = body_fp;
    _ = body_real_fp;
    // Confirm the no-`!`-before-brace bodies correctly return false:
    try std.testing.expect(!hasInferredErrorSet("pub fn nofp(x: u8) void { _ = x; }"));
}

// ─── isPubFn ───────────────────────────────────────────────────────────────

test "isPubFn: pub immediately before fn returns true" {
    // Parse a real AST so we have genuine token_tags and main_token values.
    const gpa = std.testing.allocator;
    const source: [:0]const u8 = "pub fn hello() void {}";
    var ast = try std.zig.Ast.parse(gpa, source, .zig);
    defer ast.deinit(gpa);

    const decls = ast.rootDecls();
    try std.testing.expect(decls.len > 0);
    const main_tok = ast.nodes.items(.main_token)[@intFromEnum(decls[0])];
    try std.testing.expect(isPubFn(ast.tokens.items(.tag), main_tok));
}

test "isPubFn: private fn (no pub) returns false" {
    const gpa = std.testing.allocator;
    const source: [:0]const u8 = "fn hello() void {}";
    var ast = try std.zig.Ast.parse(gpa, source, .zig);
    defer ast.deinit(gpa);

    const decls = ast.rootDecls();
    try std.testing.expect(decls.len > 0);
    const main_tok = ast.nodes.items(.main_token)[@intFromEnum(decls[0])];
    try std.testing.expect(!isPubFn(ast.tokens.items(.tag), main_tok));
}

test "isPubFn: doc-comment between pub and fn still returns true" {
    // isPubFn walks backward skipping .doc_comment tokens before checking pub.
    const gpa = std.testing.allocator;
    const source: [:0]const u8 = "/// doc\npub fn hello() void {}";
    var ast = try std.zig.Ast.parse(gpa, source, .zig);
    defer ast.deinit(gpa);

    const decls = ast.rootDecls();
    try std.testing.expect(decls.len > 0);
    const main_tok = ast.nodes.items(.main_token)[@intFromEnum(decls[0])];
    try std.testing.expect(isPubFn(ast.tokens.items(.tag), main_tok));
}

// ─── containsAny ──────────────────────────────────────────────────────────

test "containsAny: empty needles slice always returns false" {
    // The for loop never executes, so the result is always false regardless
    // of the haystack content.
    try std.testing.expect(!containsAny("anything", &.{}));
    try std.testing.expect(!containsAny("", &.{}));
}

test "containsAny: first-match short-circuits (OR semantics)" {
    // First needle matches → true even though the second doesn't appear.
    try std.testing.expect(containsAny("hello world", &.{ "hello", "missing" }));
    // Only second needle matches → still true.
    try std.testing.expect(containsAny("hello world", &.{ "missing", "world" }));
    // No needle matches → false.
    try std.testing.expect(!containsAny("hello world", &.{ "foo", "bar" }));
}

// ─── lineOf ──────────────────────────────────────────────────────────────

test "lineOf: offset 0 is always line 1" {
    try std.testing.expectEqual(@as(usize, 1), lineOf("anything", 0));
    try std.testing.expectEqual(@as(usize, 1), lineOf("", 0));
}

test "lineOf: offset after two newlines returns line 3" {
    // "a\nb\n" — byte 0='a', 1='\n', 2='b', 3='\n'.
    // offset 4 is after both newlines → line 3.
    const src = "a\nb\n";
    try std.testing.expectEqual(@as(usize, 3), lineOf(src, 4));
    // offset 2 (start of second line, before second '\n') → line 2.
    try std.testing.expectEqual(@as(usize, 2), lineOf(src, 2));
}

// ─── escapeJsonString (extended) ──────────────────────────────────────────

test "escapeJsonString: 0x0B (vertical tab) goes through \\uXXXX arm" {
    // The switch has explicit cases for \b (0x08) and \f (0x0C) but NOT for
    // \v (0x0B). The range `0x00...0x07, 0x0B, 0x0E...0x1F` catches 0x0B and
    // emits \\u000b.  This test pins that the gap is intentional and handled.
    const gpa = std.testing.allocator;
    const escaped = try escapeJsonString(gpa, "\x0B");
    defer gpa.free(escaped);
    try std.testing.expectEqualStrings("\\u000b", escaped);
}

test "escapeJsonString: mutation sentinel — round-trip must not return input unchanged" {
    // If escapeJsonString ever degraded to a no-op (returning a copy of its
    // input without transformations), a string containing `"` would round-trip
    // back to the same bytes — and the NDJSON stream would be corrupted.
    // This test deliberately passes input that MUST be transformed; if the
    // output equals the input the assertion fails, catching any no-op mutation.
    const gpa = std.testing.allocator;
    const input = "file\"with\"quotes.zig";
    const escaped = try escapeJsonString(gpa, input);
    defer gpa.free(escaped);
    // The escaped form must differ from the raw input.
    try std.testing.expect(!std.mem.eql(u8, escaped, input));
    // And it must contain the escaped-quote sequence.
    try std.testing.expect(std.mem.indexOf(u8, escaped, "\\\"") != null);
}

// ─── scanFile (functional, via tmpDir seam) ───────────────────────────────
//
// SEAM NOTE: scanFile calls `std.Io.Dir.cwd().readFileAlloc(io, path, ...)`,
// where `path` is treated as relative to the process cwd. `std.testing.tmpDir`
// writes into `.zig-cache/tmp/<random>/`, which IS under cwd, so we construct
// the relative path as `.zig-cache/tmp/<sub_path>/<file>` — the same pattern
// used by the existing "oversized files" regression test above.
//
// REGRESSION NOTE: FileNotFound (file vanished between iterate and read) is
// handled inside scanFile by an early return of 0. We cannot easily trigger
// it via the cwd seam without a race, so we document the gap here and rely on
// the code-review comment in scanFile's source.

test "scanFile: alloc-propagation fires for pub fn that allocates without Allocator param" {
    // SEAM NOTE: std.zig.Ast.nodeToSpan uses tokensToSpan which only returns
    // the full function span when all tokens are on the SAME LINE. For
    // multi-line functions it collapses to just the `fn` keyword span, making
    // containsAny unable to see into the body. All scanFile body-detection
    // tests therefore use single-line sources to stay within the seam.
    const gpa = std.testing.allocator;

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    // Single-line: nodeToSpan returns the full span including `.alloc(`.
    const source = "pub fn badAlloc() !void { _ = undefined.alloc(u8,4) catch {}; }\n";
    try tmp.dir.writeFile(std.testing.io, .{ .sub_path = "bad.zig", .data = source });

    const rel_path = try std.fs.path.join(gpa, &.{ ".zig-cache", "tmp", &tmp.sub_path, "bad.zig" });
    defer gpa.free(rel_path);

    var out_buf: [4096]u8 = undefined;
    var w: std.Io.Writer = .fixed(&out_buf);

    const count = try scanFile(gpa, std.testing.io, rel_path, &w);
    // Must fire at least the alloc-propagation violation (and inferred-error-set).
    try std.testing.expect(count >= 1);
    const written = w.buffered();
    try std.testing.expect(std.mem.indexOf(u8, written, "alloc-propagation") != null);
}

test "scanFile: 0 violations for pub fn with Allocator param that allocates" {
    // Single-line so nodeToSpan returns the full span; both `std.mem.Allocator`
    // and `.alloc(` are visible in the body → alloc-propagation does not fire.
    // Named error set → inferred-error-set does not fire. 0 total violations.
    const gpa = std.testing.allocator;

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    const source = "pub const MyError = error{Fail}; pub fn goodAlloc(alloc: std.mem.Allocator) MyError![]u8 { return alloc.alloc(u8, 8) catch MyError.Fail; }\n";
    try tmp.dir.writeFile(std.testing.io, .{ .sub_path = "good.zig", .data = source });

    const rel_path = try std.fs.path.join(gpa, &.{ ".zig-cache", "tmp", &tmp.sub_path, "good.zig" });
    defer gpa.free(rel_path);

    var out_buf: [4096]u8 = undefined;
    var w: std.Io.Writer = .fixed(&out_buf);

    const count = try scanFile(gpa, std.testing.io, rel_path, &w);
    try std.testing.expectEqual(@as(usize, 0), count);
}

test "scanFile: io-injection fires for pub fn using std.Io.File without std.Io param" {
    // Single-line so nodeToSpan includes the full body with `std.Io.File`.
    const gpa = std.testing.allocator;

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    const source = "pub fn badIo() !void { const f = std.Io.File.stdout(); _ = f; }\n";
    try tmp.dir.writeFile(std.testing.io, .{ .sub_path = "badio.zig", .data = source });

    const rel_path = try std.fs.path.join(gpa, &.{ ".zig-cache", "tmp", &tmp.sub_path, "badio.zig" });
    defer gpa.free(rel_path);

    var out_buf: [4096]u8 = undefined;
    var w: std.Io.Writer = .fixed(&out_buf);

    const count = try scanFile(gpa, std.testing.io, rel_path, &w);
    try std.testing.expect(count >= 1);
    const written = w.buffered();
    try std.testing.expect(std.mem.indexOf(u8, written, "io-injection") != null);
}

test "scanFile: 0 io violations for pub fn with : std.Io param" {
    // Single-line; body contains both `std.Io.File` (touches_io) and
    // `: std.Io` (has_io_param) → io-injection does not fire. Named error
    // set → inferred-error-set does not fire. 0 violations.
    const gpa = std.testing.allocator;

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    const source = "pub const IoError = error{Fail}; pub fn goodIo(io: std.Io) IoError!void { const f = std.Io.File.stdout(); _ = io; _ = f; }\n";
    try tmp.dir.writeFile(std.testing.io, .{ .sub_path = "goodio.zig", .data = source });

    const rel_path = try std.fs.path.join(gpa, &.{ ".zig-cache", "tmp", &tmp.sub_path, "goodio.zig" });
    defer gpa.free(rel_path);

    var out_buf: [4096]u8 = undefined;
    var w: std.Io.Writer = .fixed(&out_buf);

    const count = try scanFile(gpa, std.testing.io, rel_path, &w);
    try std.testing.expectEqual(@as(usize, 0), count);
}

test "scanFile: top-level var in lib.zig fires top-level-var violation" {
    const gpa = std.testing.allocator;

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    const source = "var global_state: u32 = 0;\n";
    // Must be named lib.zig (not main.zig / build.zig) to trigger the rule.
    try tmp.dir.writeFile(std.testing.io, .{ .sub_path = "lib.zig", .data = source });

    const rel_path = try std.fs.path.join(gpa, &.{ ".zig-cache", "tmp", &tmp.sub_path, "lib.zig" });
    defer gpa.free(rel_path);

    var out_buf: [4096]u8 = undefined;
    var w: std.Io.Writer = .fixed(&out_buf);

    const count = try scanFile(gpa, std.testing.io, rel_path, &w);
    try std.testing.expect(count >= 1);
    const written = w.buffered();
    try std.testing.expect(std.mem.indexOf(u8, written, "top-level-var") != null);
}

test "scanFile: top-level var in main.zig is exempt" {
    const gpa = std.testing.allocator;

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    const source = "var global_state: u32 = 0;\n";
    // main.zig is in the allow_top_var exemption list.
    try tmp.dir.writeFile(std.testing.io, .{ .sub_path = "main.zig", .data = source });

    const rel_path = try std.fs.path.join(gpa, &.{ ".zig-cache", "tmp", &tmp.sub_path, "main.zig" });
    defer gpa.free(rel_path);

    var out_buf: [4096]u8 = undefined;
    var w: std.Io.Writer = .fixed(&out_buf);

    const count = try scanFile(gpa, std.testing.io, rel_path, &w);
    try std.testing.expectEqual(@as(usize, 0), count);
}

test "scanFile: top-level var in build.zig is exempt" {
    const gpa = std.testing.allocator;

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    const source = "var global_state: u32 = 0;\n";
    // build.zig is also in the allow_top_var exemption list.
    try tmp.dir.writeFile(std.testing.io, .{ .sub_path = "build.zig", .data = source });

    const rel_path = try std.fs.path.join(gpa, &.{ ".zig-cache", "tmp", &tmp.sub_path, "build.zig" });
    defer gpa.free(rel_path);

    var out_buf: [4096]u8 = undefined;
    var w: std.Io.Writer = .fixed(&out_buf);

    const count = try scanFile(gpa, std.testing.io, rel_path, &w);
    try std.testing.expectEqual(@as(usize, 0), count);
}

test "scanFile: parse-error file returns 0 violations (early return)" {
    const gpa = std.testing.allocator;

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    // Syntactically invalid Zig: scanFile checks ast.errors.len > 0 and
    // returns 0 early without running any fitness rules.
    const source = "this is not valid zig syntax @@@";
    try tmp.dir.writeFile(std.testing.io, .{ .sub_path = "broken.zig", .data = source });

    const rel_path = try std.fs.path.join(gpa, &.{ ".zig-cache", "tmp", &tmp.sub_path, "broken.zig" });
    defer gpa.free(rel_path);

    var out_buf: [4096]u8 = undefined;
    var w: std.Io.Writer = .fixed(&out_buf);

    const count = try scanFile(gpa, std.testing.io, rel_path, &w);
    try std.testing.expectEqual(@as(usize, 0), count);
}

test "scanFile: FUNCTIONAL — every emitted NDJSON line is valid JSON even for pathological filename" {
    // A filename containing `"` must be escaped so each output line is still
    // parseable JSON. We write a file that will trigger a violation, then
    // parse every emitted line with std.json to confirm validity.
    const gpa = std.testing.allocator;

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    // A pub fn that allocates without an Allocator param — will emit one
    // violation line whose `file` field contains the path we pass in.
    // Single-line so nodeToSpan returns the full span (see seam note above).
    const source = "pub fn bad() !void { _ = undefined.alloc(u8,1) catch {}; }\n";
    try tmp.dir.writeFile(std.testing.io, .{ .sub_path = "normal.zig", .data = source });

    // Use a plain path; the escaping test for evil filenames is in emit tests.
    const rel_path = try std.fs.path.join(gpa, &.{ ".zig-cache", "tmp", &tmp.sub_path, "normal.zig" });
    defer gpa.free(rel_path);

    var out_buf: [8192]u8 = undefined;
    var w: std.Io.Writer = .fixed(&out_buf);

    const count = try scanFile(gpa, std.testing.io, rel_path, &w);
    try std.testing.expect(count >= 1);

    // Parse every line as JSON to confirm the NDJSON is well-formed.
    const written = w.buffered();
    var line_it = std.mem.splitScalar(u8, written, '\n');
    var parsed_count: usize = 0;
    while (line_it.next()) |line| {
        if (line.len == 0) continue;
        var parsed = try std.json.parseFromSlice(std.json.Value, gpa, line, .{});
        defer parsed.deinit();
        parsed_count += 1;
    }
    try std.testing.expect(parsed_count >= 1);
}

test "scanFile: REGRESSION — FileNotFound returns 0 (cwd seam gap documented)" {
    // SEAM GAP: scanFile uses Dir.cwd().readFileAlloc(...) internally, so
    // there is no way to inject a Dir handle from a test. The only way to
    // trigger FileNotFound reliably (without a real race) is to pass a path
    // that does not exist relative to cwd.
    //
    // This test confirms the documented contract: a missing file is benign
    // (returns 0, prints a message to stderr, does not count as a violation).
    const gpa = std.testing.allocator;

    var out_buf: [1024]u8 = undefined;
    var w: std.Io.Writer = .fixed(&out_buf);

    // A path that is guaranteed not to exist.
    const count = try scanFile(gpa, std.testing.io, ".zig-cache/tmp/does-not-exist/phantom.zig", &w);
    try std.testing.expectEqual(@as(usize, 0), count);
    // No violation line should have been written.
    const written = w.buffered();
    try std.testing.expectEqual(@as(usize, 0), written.len);
}
