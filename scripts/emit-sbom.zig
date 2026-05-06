//! emit-sbom — minimal CycloneDX 1.5 JSON emitter for Zig projects.
//!
//! Gap (plan §6): Zig 0.16 does not ship a native SBOM emitter, and the
//! widely-used `cyclonedx-cli` tool has no parser for `build.zig.zon`.
//! Until upstream closes that gap this script is the forward-compatible
//! fallback: it parses `build.zig.zon` via `std.zig.Ast` and emits a
//! CycloneDX 1.5 document listing the project itself plus every entry
//! under `.dependencies` with its `.hash` and (where available)
//! `.fingerprint`.
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
    /// The manifest declared a `.dependencies = .{...}` block but the
    /// v1 dependency-extraction stub did not return any entries. Exiting
    /// 0 in this state would publish an SBOM that silently omits every
    /// declared dependency, which is worse than failing loudly.
    IncompleteSbom,
};

pub fn main(init: std.process.Init) !u8 {
    const gpa = init.gpa;
    const io = init.io;

    var arg_iter = std.process.Args.Iterator.init(init.minimal.args);
    _ = arg_iter.next();
    const path = arg_iter.next() orelse {
        try printErr(io, "usage: emit-sbom <path-to-build.zig.zon>\n");
        return 2;
    };

    // build.zig.zon files are tiny; read with an explicit cap rather than
    // .unlimited so a tampered/unbounded file cannot OOM the emitter
    // (CodeRabbit finding). 1 MiB is far above any plausible manifest.
    const MAX_ZON_BYTES: usize = 1 << 20;
    const source = std.Io.Dir.cwd().readFileAlloc(io, path, gpa, .limited(MAX_ZON_BYTES)) catch |err| {
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
                "manifest declares `.dependencies` but the v1 stub could not extract any entries; refusing to publish an incomplete SBOM (see claude-zig-quality#TBD)",
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
/// failure path (manifest declares `.dependencies`, stub returns null) is
/// reachable from inline tests without needing a real stdout. Returns
/// `SbomError.IncompleteSbom` when the manifest has a `.dependencies`
/// block but the dependency stub yields no entries.
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
    const deps = findStructField(ast, "dependencies");
    const declares_deps = findFieldValueToken(ast, "dependencies") != null;
    // If the manifest declares a `.dependencies` block but our v1 stub
    // returned nothing, the resulting SBOM would silently omit every
    // declared dependency. Fail closed instead of fail open.
    if (deps == null and declares_deps) {
        return SbomError.IncompleteSbom;
    }
    if (deps) |dep_list| {
        for (dep_list.entries) |entry| {
            const dep_name = entry.name;
            const dep_hash = findStringFieldInStruct(ast, source, entry.init_idx, "hash") orelse "";
            const dep_url = findStringFieldInStruct(ast, source, entry.init_idx, "url") orelse "";

            const dep_name_esc = try escapeJsonString(gpa, dep_name);
            defer gpa.free(dep_name_esc);
            const dep_hash_esc = try escapeJsonString(gpa, dep_hash);
            defer gpa.free(dep_hash_esc);
            const dep_url_esc = try escapeJsonString(gpa, dep_url);
            defer gpa.free(dep_url_esc);

            if (!first) try w.print(",\n", .{});
            first = false;
            try w.print(
                \\
                \\    {{
                \\      "type": "library",
                \\      "name": "{s}",
                \\      "bom-ref": "pkg:zig/{s}",
                \\      "hashes": [ {{ "alg": "SHA-256", "content": "{s}" }} ],
                \\      "externalReferences": [ {{ "type": "distribution", "url": "{s}" }} ]
                \\    }}
            , .{ dep_name_esc, dep_name_esc, dep_hash_esc, dep_url_esc });
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

/// v1 fallback: dependency-table discovery is a TODO. Emits an empty list
/// for projects with no `.dependencies = .{...}` block (like the v0 scaffold).
// TODO(claude-zig-quality#TBD): implement v1 SBOM dependency extraction
fn findStructField(ast: std.zig.Ast, name: []const u8) ?DepList {
    _ = ast;
    _ = name;
    return null;
}

// TODO(claude-zig-quality#TBD): implement v1 SBOM dependency extraction
fn findStringFieldInStruct(
    ast: std.zig.Ast,
    source: []const u8,
    node_idx: std.zig.Ast.Node.Index,
    field: []const u8,
) ?[]const u8 {
    _ = ast;
    _ = source;
    _ = node_idx;
    _ = field;
    return null;
}

/// JSON-escape `s` per RFC 8259 §7. Escapes `"`, `\`, and the control
/// characters `\n`/`\r`/`\t`/`\b`/`\f` plus any remaining byte in the
/// `\u{0000}`-`\u{001F}` range as `\u00XX`. Caller owns the returned slice.
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

test "emitSbomDocument fails closed when manifest declares dependencies but stub returns null" {
    const gpa = std.testing.allocator;
    // Fixture mirrors a real build.zig.zon with a `.dependencies` block.
    // The v1 stub `findStructField` always returns null, so this run must
    // surface `SbomError.IncompleteSbom` rather than emit a partial SBOM.
    const fixture =
        \\.{
        \\    .name = .test_pkg,
        \\    .version = "0.1.0",
        \\    .fingerprint = 0xdeadbeefcafef00d,
        \\    .minimum_zig_version = "0.16.0",
        \\    .dependencies = .{
        \\        .some_dep = .{
        \\            .url = "https://example.invalid/x.tar.gz",
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
