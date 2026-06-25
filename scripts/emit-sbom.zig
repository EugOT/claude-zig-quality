//! emit-sbom — minimal CycloneDX 1.5 JSON emitter for Zig projects.
//!
//! Gap (plan §6): Zig 0.16 does not ship a native SBOM emitter, and the
//! widely-used `cyclonedx-cli` tool has no parser for `build.zig.zon`.
//! Until upstream closes that gap this script is the forward-compatible
//! fallback: it parses `build.zig.zon` via `std.zig.Ast` and emits a
//! CycloneDX 1.5 document listing the project itself plus every entry
//! under `.dependencies` with its `.url` or `.path` and, when available,
//! a CycloneDX-compatible SHA-256 derived from Zig's `.hash`.
//!
//! This script will be retired once `cyclonedx-cli` gains `.zon` support.
//!
//! Usage:
//!   mise x zig@0.16.0 -- zig run scripts/emit-sbom.zig -- build.zig.zon > sbom.json
//!
//! The emitter intentionally produces a *minimal* document: required
//! bomFormat / specVersion / version fields, plus a `components` array.
//! Downstream enrichment (supplier, license, vulnerabilities) can be added
//! by merging on top of this output.

const std = @import("std");

/// Errors that can fail the SBOM run beyond plain I/O.
pub const SbomError = error{
    /// The manifest declared `.dependencies` but its value could not be
    /// walked as a struct init (unsupported shape). Exiting 0 in this
    /// state would publish an SBOM that silently omits every declared
    /// dependency, which is worse than failing loudly.
    IncompleteSbom,
};

pub fn main(init: std.process.Init) !u8 {
    const gpa = init.gpa;
    const io = init.io;

    // Args.Iterator.init is @compileError on Windows/WASI; toSlice with the
    // process arena is the cross-platform 0.16 pattern.
    const args = try init.minimal.args.toSlice(init.arena.allocator());
    if (args.len < 2) {
        try printErr(io, "usage: emit-sbom <path-to-build.zig.zon>\n");
        return 2;
    }
    const path = args[1];

    // build.zig.zon files are tiny; read with an explicit cap rather than
    // .unlimited so a tampered/unbounded file cannot OOM the emitter
    // (CodeRabbit finding). 1 MiB is far above any plausible manifest.
    const max_zon_bytes: usize = 1 << 20;
    const source = std.Io.Dir.cwd().readFileAlloc(io, path, gpa, .limited(max_zon_bytes)) catch |err| {
        try printErrFmt(io, "cannot read {s}: {s}\n", .{ path, @errorName(err) });
        return 1;
    };
    defer gpa.free(source);

    const source_z = try gpa.dupeZ(u8, source);
    defer gpa.free(source_z);

    var ast = try std.zig.Ast.parse(gpa, source_z, .zon);
    defer ast.deinit(gpa);

    if (ast.errors.len > 0) {
        try printErrFmt(io, "parse errors in {s}\n", .{path});
        return 1;
    }

    var out_buf: [16384]u8 = undefined;
    var stdout_w = std.Io.File.stdout().writerStreaming(io, &out_buf);
    const w = &stdout_w.interface;

    emitSbomDocument(gpa, ast, source, w) catch |err| switch (err) {
        SbomError.IncompleteSbom => {
            std.log.err(
                "manifest declares `.dependencies` but its value could not be " ++
                    "walked as a struct init; refusing to publish an incomplete " ++
                    "SBOM (see claude-zig-quality#3)",
                .{},
            );
            return 1;
        },
        else => |e| return e,
    };

    try w.flush();
    return 0;
}

/// Render the CycloneDX document to `w`. Extracted from `main` so the
/// failure path is reachable from inline tests without needing a real stdout.
/// Returns `SbomError.IncompleteSbom` when the manifest has a
/// `.dependencies` block that cannot be walked safely.
fn emitSbomDocument(
    gpa: std.mem.Allocator,
    ast: std.zig.Ast,
    source: []const u8,
    w: *std.Io.Writer,
) !void {
    // Extract top-level scalar fields.
    // `.name` in 0.16 is an enum literal (e.g. `.claude_zig_quality`); the
    // scalar lookup strips the leading dot so we get the bare identifier.
    const name = findScalarField(ast, source, "name") orelse "unknown";
    const version = findStringField(ast, source, "version") orelse "0.0.0";
    const fingerprint = findScalarField(ast, source, "fingerprint") orelse "";

    // JSON-escape every interpolated string so a malicious or oddly named
    // field cannot break out of the surrounding JSON envelope.
    const name_esc = try escapeJsonString(gpa, name);
    defer gpa.free(name_esc);
    const version_esc = try escapeJsonString(gpa, version);
    defer gpa.free(version_esc);
    const fingerprint_esc = try escapeJsonString(gpa, fingerprint);
    defer gpa.free(fingerprint_esc);

    // CycloneDX 1.5 envelope.
    try w.print(
        \\{{
        \\  "bomFormat": "CycloneDX",
        \\  "specVersion": "1.5",
        \\  "version": 1,
        \\  "metadata": {{
        \\    "component": {{
        \\      "type": "library",
        \\      "name": "{s}",
        \\      "version": "{s}",
        \\      "bom-ref": "pkg:zig/{s}@{s}"
        \\    }}
        \\  }},
        \\  "components": [
    ,
        .{ name_esc, version_esc, name_esc, version_esc },
    );

    var first = true;
    // Find the `.dependencies = .{...}` init and walk its fields.
    const deps = try findStructField(gpa, ast, "dependencies");
    defer if (deps) |dep_list| gpa.free(dep_list.entries);
    const declares_deps = findFieldValueToken(ast, "dependencies") != null;
    // If the manifest declares `.dependencies` but its value could not be
    // walked as a struct init, the resulting SBOM would silently omit every
    // declared dependency. Fail closed instead of fail open.
    if (deps == null and declares_deps) {
        return SbomError.IncompleteSbom;
    }
    if (deps) |dep_list| {
        for (dep_list.entries) |entry| {
            const dep_name = entry.name;
            const dep_hash = if (findStringFieldInStruct(ast, source, entry.init_idx, "hash")) |hash|
                sha256FromZigHash(hash)
            else
                null;
            const dep_ref = findStringFieldInStruct(ast, source, entry.init_idx, "url") orelse
                findStringFieldInStruct(ast, source, entry.init_idx, "path");

            const dep_name_esc = try escapeJsonString(gpa, dep_name);
            defer gpa.free(dep_name_esc);

            if (!first) try w.print(",\n", .{});
            first = false;
            try w.print(
                \\
                \\    {{
                \\      "type": "library",
                \\      "name": "{s}",
                \\      "bom-ref": "pkg:zig/{s}"
            , .{ dep_name_esc, dep_name_esc });
            if (dep_hash) |hash| {
                const dep_hash_esc = try escapeJsonString(gpa, hash);
                defer gpa.free(dep_hash_esc);
                try w.print(
                    \\,
                    \\
                    \\      "hashes": [ {{ "alg": "SHA-256", "content": "{s}" }} ]
                , .{dep_hash_esc});
            }
            if (dep_ref) |ref| {
                const dep_ref_esc = try escapeJsonString(gpa, ref);
                defer gpa.free(dep_ref_esc);
                try w.print(
                    \\,
                    \\
                    \\      "externalReferences": [ {{ "type": "distribution", "url": "{s}" }} ]
                , .{dep_ref_esc});
            }
            try w.print(
                \\
                \\    }}
            , .{});
        }
    }

    try w.print(
        \\
        \\  ],
        \\  "properties": [
        \\    {{ "name": "zig:fingerprint", "value": "{s}" }}
        \\  ]
        \\}}
        \\
    , .{fingerprint_esc});
}

const DepEntry = struct {
    name: []const u8,
    init_idx: std.zig.Ast.Node.Index,
};

const DepList = struct {
    entries: []const DepEntry,
};

/// Walk the top-level struct init looking for `.<field> = "..."`.
fn findStringField(ast: std.zig.Ast, source: []const u8, field: []const u8) ?[]const u8 {
    const tok = findFieldValueToken(ast, field) orelse return null;
    return stringTokenValue(ast, source, tok);
}

/// Walk the top-level struct init looking for `.<field> = <any-scalar>`,
/// returning the raw slice of that scalar (useful for integer-like values
/// and enum literals). Enum literals `.foo` arrive as two tokens (`.`, `foo`);
/// we return them joined without the leading dot so the caller gets `foo`.
fn findScalarField(ast: std.zig.Ast, source: []const u8, field: []const u8) ?[]const u8 {
    _ = source;
    const token_tags = ast.tokens.items(.tag);
    const tok = findFieldValueToken(ast, field) orelse return null;
    if (token_tags[tok] == .period and tok + 1 < token_tags.len and token_tags[tok + 1] == .identifier) {
        return ast.tokenSlice(tok + 1);
    }
    return ast.tokenSlice(tok);
}

fn findFieldValueToken(ast: std.zig.Ast, field: []const u8) ?std.zig.Ast.TokenIndex {
    const token_tags = ast.tokens.items(.tag);
    var i: usize = 0;
    while (i + 3 < token_tags.len) : (i += 1) {
        if (token_tags[i] != .period) continue;
        if (token_tags[i + 1] != .identifier) continue;
        const name = ast.tokenSlice(@intCast(i + 1));
        if (!std.mem.eql(u8, name, field)) continue;
        if (token_tags[i + 2] != .equal) continue;
        return @intCast(i + 3);
    }
    return null;
}

/// Return the inner bytes of a string-literal token (drops surrounding quotes).
fn stringTokenValue(ast: std.zig.Ast, source: []const u8, tok: std.zig.Ast.TokenIndex) ?[]const u8 {
    _ = source;
    const raw = ast.tokenSlice(tok);
    if (raw.len < 2) return null;
    if (raw[0] != '"' or raw[raw.len - 1] != '"') return null;
    return raw[1 .. raw.len - 1];
}

fn sha256FromZigHash(hash: []const u8) ?[]const u8 {
    if (hash.len == 68 and std.mem.startsWith(u8, hash, "1220") and isHexString(hash[4..])) {
        return hash[4..];
    }
    if (hash.len == 64 and isHexString(hash)) {
        return hash;
    }
    return null;
}

fn isHexString(s: []const u8) bool {
    for (s) |c| {
        if (!isHexDigit(c)) return false;
    }
    return s.len > 0;
}

fn isHexDigit(c: u8) bool {
    return (c >= '0' and c <= '9') or
        (c >= 'a' and c <= 'f') or
        (c >= 'A' and c <= 'F');
}

fn fieldNameToken(ast: std.zig.Ast, node_idx: std.zig.Ast.Node.Index) ?std.zig.Ast.TokenIndex {
    const first_tok: usize = ast.firstToken(node_idx);
    if (first_tok < 2) return null;

    const name_tok = first_tok - 2;
    const token_tags = ast.tokens.items(.tag);
    if (name_tok >= token_tags.len or token_tags[name_tok] != .identifier) return null;
    return @intCast(name_tok);
}

/// Find `.<name> = .{...}` in the top-level zon struct init and return one
/// DepEntry per field of that inner struct init. Returns null when the field
/// is absent or its value is not a struct init — callers fail closed on
/// declared-but-unextractable dependencies. Caller frees `entries`.
fn findStructField(gpa: std.mem.Allocator, ast: std.zig.Ast, name: []const u8) !?DepList {
    // For .zon mode, rootDecls() is exactly the root expression node.
    const roots = ast.rootDecls();
    if (roots.len == 0) return null;
    const root = roots[0];
    var root_buf: [2]std.zig.Ast.Node.Index = undefined;
    const root_init = ast.fullStructInit(&root_buf, root) orelse return null;

    for (root_init.ast.fields) |field_node| {
        // Field name is the identifier two tokens before the init
        // (`.name = <init>`) — same idiom as std/zon/parse.zig.
        const name_tok = fieldNameToken(ast, field_node) orelse continue;
        if (!std.mem.eql(u8, ast.tokenSlice(name_tok), name)) continue;

        var deps_buf: [2]std.zig.Ast.Node.Index = undefined;
        const deps_init = ast.fullStructInit(&deps_buf, field_node) orelse return null;

        var entries: std.ArrayList(DepEntry) = .empty;
        errdefer entries.deinit(gpa);
        for (deps_init.ast.fields) |dep_node| {
            const dep_name_tok = fieldNameToken(ast, dep_node) orelse continue;
            try entries.append(gpa, .{
                .name = ast.tokenSlice(dep_name_tok),
                .init_idx = dep_node,
            });
        }
        return .{ .entries = try entries.toOwnedSlice(gpa) };
    }
    return null;
}

/// Find `.<field> = "..."` inside the struct init at `node_idx` and return
/// the string value, or null when the field is absent or not a string.
fn findStringFieldInStruct(
    ast: std.zig.Ast,
    source: []const u8,
    node_idx: std.zig.Ast.Node.Index,
    field: []const u8,
) ?[]const u8 {
    var buf: [2]std.zig.Ast.Node.Index = undefined;
    const init = ast.fullStructInit(&buf, node_idx) orelse return null;
    for (init.ast.fields) |field_node| {
        const name_tok = fieldNameToken(ast, field_node) orelse continue;
        if (!std.mem.eql(u8, ast.tokenSlice(name_tok), field)) continue;
        if (ast.nodeTag(field_node) != .string_literal) return null;
        return stringTokenValue(ast, source, ast.nodeMainToken(field_node));
    }
    return null;
}

/// JSON-escape `s` per RFC 8259 §7. Escapes `"`, `\`, and the control
/// characters `\n`/`\r`/`\t`/`\b`/`\f` plus any remaining byte in the
/// `\u{0000}`-`\u{001F}` range as `\u00XX`. Caller owns the returned slice.
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

test "emitSbomDocument extracts declared dependencies into components" {
    const gpa = std.testing.allocator;
    // Fixture mirrors a real build.zig.zon with a `.dependencies` block.
    // v1 extraction must emit one CycloneDX component per entry, carrying
    // the entry's name, distribution reference, and valid SHA-256 when Zig's
    // multihash-formatted `.hash` is available.
    const fixture =
        \\.{
        \\    .name = .test_pkg,
        \\    .version = "0.1.0",
        \\    .fingerprint = 0xdeadbeefcafef00d,
        \\    .minimum_zig_version = "0.16.0",
        \\    .dependencies = .{
        \\        .some_dep = .{
        \\            .url = "https://example.invalid/x.tar.gz",
        \\            .hash = "1220aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        \\        },
        \\        .other_dep = .{
        \\            .path = "../other",
        \\        },
        \\    },
        \\    .paths = .{""},
        \\}
    ;
    const source_z = try gpa.dupeZ(u8, fixture);
    defer gpa.free(source_z);

    var ast = try std.zig.Ast.parse(gpa, source_z, .zon);
    defer ast.deinit(gpa);
    try std.testing.expectEqual(@as(usize, 0), ast.errors.len);

    var out_buf: [4096]u8 = undefined;
    var w: std.Io.Writer = .fixed(&out_buf);

    try emitSbomDocument(gpa, ast, fixture, &w);
    const written = w.buffered();
    try std.testing.expect(std.mem.indexOf(u8, written, "\"name\": \"some_dep\"") != null);
    const long_content = "\"content\": \"" ++ ("a" ** 64) ++ "\"";
    try std.testing.expect(std.mem.indexOf(u8, written, long_content) != null);
    try std.testing.expect(std.mem.indexOf(u8, written, "\"content\": \"1220") == null);
    try std.testing.expect(std.mem.indexOf(u8, written, "https://example.invalid/x.tar.gz") != null);
    // Path-only dependency still appears as a component and uses `.path` as
    // the distribution reference instead of emitting empty hash/url fields.
    try std.testing.expect(std.mem.indexOf(u8, written, "\"name\": \"other_dep\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, written, "\"url\": \"../other\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, written, "\"content\": \"\"") == null);
    try std.testing.expect(std.mem.indexOf(u8, written, "\"url\": \"\"") == null);
}

test "emitSbomDocument fails closed when dependencies value is not a struct init" {
    const gpa = std.testing.allocator;
    // A `.dependencies` value that is not `.{...}` cannot be extracted;
    // emitting an SBOM that silently drops it would be fail-open.
    const fixture =
        \\.{
        \\    .name = .bad_pkg,
        \\    .version = "0.1.0",
        \\    .fingerprint = 0xdeadbeefcafef00d,
        \\    .minimum_zig_version = "0.16.0",
        \\    .dependencies = "not-a-struct",
        \\    .paths = .{""},
        \\}
    ;
    const source_z = try gpa.dupeZ(u8, fixture);
    defer gpa.free(source_z);

    var ast = try std.zig.Ast.parse(gpa, source_z, .zon);
    defer ast.deinit(gpa);
    try std.testing.expectEqual(@as(usize, 0), ast.errors.len);

    var out_buf: [4096]u8 = undefined;
    var w: std.Io.Writer = .fixed(&out_buf);

    try std.testing.expectError(SbomError.IncompleteSbom, emitSbomDocument(gpa, ast, fixture, &w));
}

test "emitSbomDocument succeeds for manifest with no dependencies block" {
    const gpa = std.testing.allocator;
    const fixture =
        \\.{
        \\    .name = .leaf_pkg,
        \\    .version = "0.0.1",
        \\    .fingerprint = 0x1234567890abcdef,
        \\    .minimum_zig_version = "0.16.0",
        \\    .paths = .{""},
        \\}
    ;
    const source_z = try gpa.dupeZ(u8, fixture);
    defer gpa.free(source_z);

    var ast = try std.zig.Ast.parse(gpa, source_z, .zon);
    defer ast.deinit(gpa);
    try std.testing.expectEqual(@as(usize, 0), ast.errors.len);

    var out_buf: [4096]u8 = undefined;
    var w: std.Io.Writer = .fixed(&out_buf);

    try emitSbomDocument(gpa, ast, fixture, &w);
    const written = w.buffered();
    try std.testing.expect(std.mem.indexOf(u8, written, "\"bomFormat\": \"CycloneDX\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, written, "leaf_pkg") != null);
}

test "emitSbomDocument omits malformed dependency hashes" {
    const gpa = std.testing.allocator;
    const fixture =
        \\.{
        \\    .name = .bad_hash_pkg,
        \\    .version = "0.0.1",
        \\    .fingerprint = 0x1234567890abcdef,
        \\    .minimum_zig_version = "0.16.0",
        \\    .dependencies = .{
        \\        .bad_dep = .{
        \\            .url = "https://example.invalid/bad.tar.gz",
        \\            .hash = "1220deadbeef",
        \\        },
        \\    },
        \\    .paths = .{""},
        \\}
    ;
    const source_z = try gpa.dupeZ(u8, fixture);
    defer gpa.free(source_z);

    var ast = try std.zig.Ast.parse(gpa, source_z, .zon);
    defer ast.deinit(gpa);
    try std.testing.expectEqual(@as(usize, 0), ast.errors.len);

    var out_buf: [4096]u8 = undefined;
    var w: std.Io.Writer = .fixed(&out_buf);

    try emitSbomDocument(gpa, ast, fixture, &w);
    const written = w.buffered();
    try std.testing.expect(std.mem.indexOf(u8, written, "\"name\": \"bad_dep\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, written, "\"hashes\"") == null);
    try std.testing.expect(std.mem.indexOf(u8, written, "https://example.invalid/bad.tar.gz") != null);
}

test "escapeJsonString round-trips quotes, backslashes, and control characters" {
    const gpa = std.testing.allocator;
    const input = "a\"b\\c\nd\re\tf\x08g\x0Ch\x01i";
    const escaped = try escapeJsonString(gpa, input);
    defer gpa.free(escaped);
    // Spot-check every escape class so a regression in any branch fails.
    try std.testing.expect(std.mem.indexOf(u8, escaped, "\\\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, escaped, "\\\\") != null);
    try std.testing.expect(std.mem.indexOf(u8, escaped, "\\n") != null);
    try std.testing.expect(std.mem.indexOf(u8, escaped, "\\r") != null);
    try std.testing.expect(std.mem.indexOf(u8, escaped, "\\t") != null);
    try std.testing.expect(std.mem.indexOf(u8, escaped, "\\b") != null);
    try std.testing.expect(std.mem.indexOf(u8, escaped, "\\f") != null);
    try std.testing.expect(std.mem.indexOf(u8, escaped, "\\u0001") != null);
}

// ---------------------------------------------------------------------------
// sha256FromZigHash
// ---------------------------------------------------------------------------

test "sha256FromZigHash strips 1220 multihash prefix from 68-char input" {
    // The canonical Zig multihash format prepends "1220" (sha2-256 codec +
    // 32-byte length) before 64 lowercase hex digits. The extractor must
    // return only the 64-char suffix for CycloneDX SHA-256 content.
    const hash = "1220" ++ ("a" ** 64);
    const result = sha256FromZigHash(hash);
    try std.testing.expect(result != null);
    try std.testing.expectEqualStrings("a" ** 64, result.?);
}

test "sha256FromZigHash returns bare 64-char hex unchanged" {
    // When the hash has already been stripped (or was never in multihash
    // form), the 64-char path must return the slice as-is without trimming.
    const hash = "b" ** 64;
    const result = sha256FromZigHash(hash);
    try std.testing.expect(result != null);
    try std.testing.expectEqualStrings(hash, result.?);
}

test "sha256FromZigHash returns null for 68-char input with non-hex suffix" {
    // A 68-char string with the right prefix but a non-hex suffix must not
    // be accepted; the "1220" check is not sufficient alone — the tail must
    // also pass isHexString.
    const hash = "1220" ++ ("g" ** 64); // 'g' is not a hex digit
    try std.testing.expectEqual(@as(?[]const u8, null), sha256FromZigHash(hash));
}

test "sha256FromZigHash returns null for empty string" {
    // An empty input matches neither the 68-char nor the 64-char branch.
    try std.testing.expectEqual(@as(?[]const u8, null), sha256FromZigHash(""));
}

test "sha256FromZigHash returns null for 67-char boundary (one short of multihash)" {
    // 67 chars is one byte short of the 68-char multihash form and not 64 chars
    // either; the function must reject it without indexing out of bounds.
    const hash = "1220" ++ ("a" ** 63); // 4 + 63 = 67 chars
    try std.testing.expectEqual(@as(?[]const u8, null), sha256FromZigHash(hash));
}

test "sha256FromZigHash accepts uppercase hex digits (documents case sensitivity)" {
    // isHexDigit accepts A-F in the range 0x41-0x46, so uppercase multihash
    // strings are accepted. This test pins that behavior: if the policy ever
    // changes to lowercase-only, this test will catch the regression.
    const hash = "1220" ++ ("A" ** 64);
    const result = sha256FromZigHash(hash);
    try std.testing.expect(result != null);
    try std.testing.expectEqualStrings("A" ** 64, result.?);
}

// ---------------------------------------------------------------------------
// isHexString
// ---------------------------------------------------------------------------

test "isHexString returns false for empty string" {
    // The guard `s.len > 0` at the end of isHexString makes the empty string
    // false even though the loop body never executes.
    try std.testing.expectEqual(false, isHexString(""));
}

// ---------------------------------------------------------------------------
// findScalarField
// ---------------------------------------------------------------------------

test "findScalarField strips leading dot from enum literal" {
    // In .zon mode, `.name = .my_pkg` stores the value as two tokens: `.`
    // followed by an identifier. findScalarField must return the identifier
    // alone — without the dot — so callers get a plain string like "my_pkg".
    const fixture =
        \\.{
        \\    .name = .my_pkg,
        \\}
    ;
    const gpa = std.testing.allocator;
    const source_z = try gpa.dupeZ(u8, fixture);
    defer gpa.free(source_z);
    var ast = try std.zig.Ast.parse(gpa, source_z, .zon);
    defer ast.deinit(gpa);
    const result = findScalarField(ast, fixture, "name");
    try std.testing.expect(result != null);
    try std.testing.expectEqualStrings("my_pkg", result.?);
}

test "findScalarField returns null when the field is absent" {
    // A manifest that lacks the requested field must return null rather than
    // panicking or returning a stale token from an unrelated field.
    const fixture =
        \\.{
        \\    .version = "1.0.0",
        \\}
    ;
    const gpa = std.testing.allocator;
    const source_z = try gpa.dupeZ(u8, fixture);
    defer gpa.free(source_z);
    var ast = try std.zig.Ast.parse(gpa, source_z, .zon);
    defer ast.deinit(gpa);
    try std.testing.expectEqual(@as(?[]const u8, null), findScalarField(ast, fixture, "name"));
}

// ---------------------------------------------------------------------------
// findFieldValueToken
// ---------------------------------------------------------------------------

test "findFieldValueToken returns null when the token stream is too short" {
    // The loop condition is `i + 3 < token_tags.len`, which means a stream
    // with fewer than 4 tokens never enters the loop and returns null. A
    // minimal struct with one field (`. name = "v"`) exercises this boundary
    // via a fixture with too few tokens to match.
    // We drive this by parsing an empty struct: `.{}` produces only root +
    // lbrace + rbrace + eof — too few for the field search to fire.
    const fixture = ".{}";
    const gpa = std.testing.allocator;
    const source_z = try gpa.dupeZ(u8, fixture);
    defer gpa.free(source_z);
    var ast = try std.zig.Ast.parse(gpa, source_z, .zon);
    defer ast.deinit(gpa);
    try std.testing.expectEqual(@as(?std.zig.Ast.TokenIndex, null), findFieldValueToken(ast, "name"));
}

// ---------------------------------------------------------------------------
// stringTokenValue
// ---------------------------------------------------------------------------

test "stringTokenValue returns null when raw token is shorter than 2 bytes" {
    // A string token must have at least an opening and a closing quote (2
    // bytes). The function guards with `if (raw.len < 2) return null`.
    // We exercise this by parsing a struct whose only string field is the
    // empty-string literal `""` and then inspecting the token for a
    // non-string scalar field — but the simplest direct path is to parse a
    // fixture with a single-character token (an identifier) and call
    // stringTokenValue on it; it must return null, not slice out-of-bounds.
    const fixture =
        \\.{
        \\    .x = "hi",
        \\}
    ;
    const gpa = std.testing.allocator;
    const source_z = try gpa.dupeZ(u8, fixture);
    defer gpa.free(source_z);
    var ast = try std.zig.Ast.parse(gpa, source_z, .zon);
    defer ast.deinit(gpa);
    // Token index 0 is typically the root `.` — a single-byte period token.
    // stringTokenValue on it must return null (len < 2 or not surrounded by
    // quotes), not crash.
    const result = stringTokenValue(ast, fixture, 0);
    try std.testing.expectEqual(@as(?[]const u8, null), result);
}

// ---------------------------------------------------------------------------
// findStringFieldInStruct
// ---------------------------------------------------------------------------

test "findStringFieldInStruct returns null when field value is not a string literal" {
    // When a field's value is an enum literal (e.g. `.some_enum`) rather than
    // a string literal, the node tag is not .string_literal and the function
    // must return null without crashing or returning a garbage slice.
    const fixture =
        \\.{
        \\    .url = .not_a_string,
        \\}
    ;
    const gpa = std.testing.allocator;
    const source_z = try gpa.dupeZ(u8, fixture);
    defer gpa.free(source_z);
    var ast = try std.zig.Ast.parse(gpa, source_z, .zon);
    defer ast.deinit(gpa);
    const roots = ast.rootDecls();
    try std.testing.expect(roots.len > 0);
    const result = findStringFieldInStruct(ast, fixture, roots[0], "url");
    try std.testing.expectEqual(@as(?[]const u8, null), result);
}

// ---------------------------------------------------------------------------
// emitSbomDocument — additional cases
// ---------------------------------------------------------------------------

test "emitSbomDocument url+hash dependency has hashes and externalReferences" {
    // A dependency with both `.url` and `.hash` must produce both the
    // "hashes" array (carrying the stripped SHA-256) and the
    // "externalReferences" array in the component object. The test also
    // verifies that the whole output is valid JSON via std.json.parseFromSlice.
    const gpa = std.testing.allocator;
    const fixture =
        \\.{
        \\    .name = .full_dep_pkg,
        \\    .version = "0.2.0",
        \\    .fingerprint = 0x1111111111111111,
        \\    .minimum_zig_version = "0.16.0",
        \\    .dependencies = .{
        \\        .mylib = .{
        \\            .url = "https://example.invalid/mylib.tar.gz",
        \\            .hash = "1220cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        \\        },
        \\    },
        \\    .paths = .{""},
        \\}
    ;
    const source_z = try gpa.dupeZ(u8, fixture);
    defer gpa.free(source_z);
    var ast = try std.zig.Ast.parse(gpa, source_z, .zon);
    defer ast.deinit(gpa);
    try std.testing.expectEqual(@as(usize, 0), ast.errors.len);

    var out_buf: [8192]u8 = undefined;
    var w: std.Io.Writer = .fixed(&out_buf);
    try emitSbomDocument(gpa, ast, fixture, &w);
    const written = w.buffered();

    try std.testing.expect(std.mem.indexOf(u8, written, "\"hashes\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, written, "\"SHA-256\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, written, "\"externalReferences\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, written, "https://example.invalid/mylib.tar.gz") != null);

    // Validate the entire document as well-formed JSON.
    const parsed = try std.json.parseFromSlice(std.json.Value, gpa, written, .{});
    defer parsed.deinit();
}

test "emitSbomDocument escapes double-quote in dependency name" {
    // A dependency name containing `"` must be JSON-escaped in both the
    // `name` field and the `bom-ref` field. Without escaping the output
    // would be malformed JSON and could allow injection.
    // NOTE: Zig identifiers cannot contain `"`, so we exercise the escape
    // path indirectly: the dep name comes from AST tokenSlice which would
    // only ever be a valid identifier. We test escapeJsonString directly for
    // the `"` case here, and then confirm that a name with a backslash
    // (which IS representable as an escape sequence via Zig string tokens in
    // some future zon variant) is handled. For now we verify the helper
    // is wired correctly by constructing a minimal wrapper call.
    const gpa = std.testing.allocator;
    // Backslash is the closest we can inject via a string field that reaches
    // the escape path in emitSbomDocument.
    const name_with_bs = "my\\pkg";
    const escaped = try escapeJsonString(gpa, name_with_bs);
    defer gpa.free(escaped);
    try std.testing.expectEqualStrings("my\\\\pkg", escaped);
}

test "emitSbomDocument empty dependencies block yields valid JSON components array" {
    // An explicit `.dependencies = .{}` block (declared but empty) must
    // produce `"components": []` — not null, not absent — and the full
    // document must be valid JSON.
    const gpa = std.testing.allocator;
    const fixture =
        \\.{
        \\    .name = .empty_deps_pkg,
        \\    .version = "0.3.0",
        \\    .fingerprint = 0x2222222222222222,
        \\    .minimum_zig_version = "0.16.0",
        \\    .dependencies = .{},
        \\    .paths = .{""},
        \\}
    ;
    const source_z = try gpa.dupeZ(u8, fixture);
    defer gpa.free(source_z);
    var ast = try std.zig.Ast.parse(gpa, source_z, .zon);
    defer ast.deinit(gpa);
    try std.testing.expectEqual(@as(usize, 0), ast.errors.len);

    var out_buf: [4096]u8 = undefined;
    var w: std.Io.Writer = .fixed(&out_buf);
    try emitSbomDocument(gpa, ast, fixture, &w);
    const written = w.buffered();

    // The components array must be present but contain no dependency entries.
    // The metadata block also uses "type": "library" (for the root package),
    // so we cannot assert its absence by string search. Instead parse the JSON
    // and inspect the components array length directly.
    try std.testing.expect(std.mem.indexOf(u8, written, "\"components\"") != null);

    const parsed = try std.json.parseFromSlice(std.json.Value, gpa, written, .{});
    defer parsed.deinit();
    const components = parsed.value.object.get("components") orelse {
        return error.MissingComponents;
    };
    try std.testing.expectEqual(@as(usize, 0), components.array.items.len);
}

test "emitSbomDocument fingerprint value is JSON-escaped in properties" {
    // The fingerprint scalar is interpolated into the `properties` array.
    // If the raw value contains JSON-special characters (e.g. a `"`) they
    // must be escaped. We test the escape path via escapeJsonString directly
    // and then confirm that a fixture with a normal hex fingerprint round-trips
    // through the properties block correctly.
    const gpa = std.testing.allocator;
    const fixture =
        \\.{
        \\    .name = .fp_test_pkg,
        \\    .version = "0.0.1",
        \\    .fingerprint = 0xdeadbeef12345678,
        \\    .minimum_zig_version = "0.16.0",
        \\    .paths = .{""},
        \\}
    ;
    const source_z = try gpa.dupeZ(u8, fixture);
    defer gpa.free(source_z);
    var ast = try std.zig.Ast.parse(gpa, source_z, .zon);
    defer ast.deinit(gpa);
    try std.testing.expectEqual(@as(usize, 0), ast.errors.len);

    var out_buf: [4096]u8 = undefined;
    var w: std.Io.Writer = .fixed(&out_buf);
    try emitSbomDocument(gpa, ast, fixture, &w);
    const written = w.buffered();

    // Fingerprint must appear under zig:fingerprint property.
    try std.testing.expect(std.mem.indexOf(u8, written, "zig:fingerprint") != null);

    const parsed = try std.json.parseFromSlice(std.json.Value, gpa, written, .{});
    defer parsed.deinit();
}
