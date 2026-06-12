# Zig Error Set Discipline

Zig errors are a **control-flow primitive**, not just a reporting one.
Precise error sets give the compiler full knowledge of every branch;
inferred or `anyerror` surfaces lose that. For 0.16-specific error-name
renames covered by authoritative citations, see rows 4–5 of
`0.16-grounded-facts.md` (io-parameter close/reader migration) and the
renames table below.

## Rules

### R1 — Public APIs declare named error sets

```zig
// Good
pub const ParseError = error{
    UnexpectedToken,
    TrailingJunk,
    IntegerOverflow,
};
pub fn parse(input: []const u8) ParseError!Ast { ... }

// Bad — inferred set leaks implementation
pub fn parse(input: []const u8) !Ast { ... }

// Worse — anyerror
pub fn parse(input: []const u8) anyerror!Ast { ... }
```

Inferred error sets on public fns are acceptable **only** for private
helpers or local prototypes. Every crate boundary crossing needs a
declared set.

### R2 — Compose with `||`

```zig
pub const ReadError =
    ParseError || std.Io.Dir.OpenError || std.Io.File.ReadError;
pub fn readAndParse(io: std.Io, dir: std.Io.Dir, path: []const u8) ReadError!Ast { ... }
```

Composition makes the failure surface inspectable at type level.

### R3 — `switch` on errors: avoid `else => ...` on public-API error unions

```zig
// Good — exhaustive, forces update when upstream adds variants
switch (err) {
    error.UnexpectedToken => try reportSyntax(err),
    error.TrailingJunk    => try reportTrailing(err),
    error.IntegerOverflow => try reportOverflow(err),
}

// Bad — swallows future additions
switch (err) {
    error.UnexpectedToken => try reportSyntax(err),
    else => try reportUnknown(err),
}
```

`else =>` is fine for **private** unions where you control the full
set. For public ones, require exhaustive — the compiler will tell you
when callers need updating.

### R4 — No sentinel `null` / `-1` / error codes from int returns

If it can fail, return `!T`. Error unions are almost free at runtime,
so there is no performance reason to simulate sentinel returns.

### R5 — `errdefer` every resource acquisition

```zig
const buf = try gpa.alloc(u8, n);
errdefer gpa.free(buf);
const file = try dir.openFile(io, path, .{});
errdefer file.close(io);
try populate(buf, file);
return .{ .buf = buf, .file = file };
```

A missing `errdefer` between two allocations is a leak on the second
one's failure path. See `allocator-discipline.md` R7 for the matching
allocator view.

## 0.16 error-name renames

| Old | New |
|---|---|
| `error.RenameAcrossMountPoints`, `error.NotSameFileSystem` | `error.CrossDevice` |
| `error.SharingViolation` | `error.FileBusy` |
| `error.EnvironmentVariableNotFound` | `error.EnvironmentVariableMissing` |

Grep for the old names before declaring a 0.16 migration done.

## Reifying error sets

Not possible in 0.16. Error sets cannot be constructed via `@Type`
(removed) or any replacement builtin. Error sets are declarable only by
literal syntax. If metaprogramming depended on reification, refactor to
a runtime enum + explicit error.

## Patterns

### Rich context via payload + narrow error tag

```zig
pub const ParseError = error{ UnexpectedToken };

pub const ParseDiag = struct {
    err: ParseError,
    line: u32,
    column: u32,
    snippet: []const u8,
};

pub fn parse(input: []const u8, diag: ?*ParseDiag) ParseError!Ast {
    // ...
    if (unexpected) {
        if (diag) |d| d.* = .{
            .err = error.UnexpectedToken,
            .line = line,
            .column = col,
            .snippet = slice,
        };
        return error.UnexpectedToken;
    }
}
```

Error sets stay narrow; diagnostic payload travels out of band.
Callers that want detail opt in.

### Propagation without widening

```zig
pub const DoSomethingError = error{SomeFailure};
pub const HigherLevelError = DoSomethingError || error{OtherFailure};

pub fn higher() HigherLevelError!void {
    try doSomething();  // error.SomeFailure promotes cleanly
}
```

### Testing error paths

```zig
test "parse rejects trailing garbage" {
    try std.testing.expectError(error.TrailingJunk, parse("1 2"));
}

test "parse yields specific diag on invalid token" {
    var diag: ParseDiag = undefined;
    try std.testing.expectError(error.UnexpectedToken, parse("@@@", &diag));
    try std.testing.expectEqual(@as(u32, 1), diag.line);
}
```

## AST rules (for lint)

- `pub fn.*\!` (bang-arrow) with implicit set → warn; require a named set.
- `anyerror` in public API → deny.
- `switch` on `@TypeOf(err)` where `@TypeOf(err)` is a public error
  union and an `else =>` branch is present → warn.
- `catch unreachable` on I/O errors → warn (near-certainly a bug;
  I/O can always fail).

## When `catch unreachable` is OK

Only when you have statically proven the fallible thing cannot fail.

```zig
// OK — we know this buffer is ≥ needed
const n = std.fmt.bufPrint(&buf, "{d}", .{x}) catch unreachable;
```

Everywhere else, `catch unreachable` is a bug. Prefer
`catch |err| std.debug.panic(...)` so failures at least surface at
runtime instead of silent UB in release.

## Philosophy

Error sets are part of the type. Treat them with the same rigor as the
happy-path return type. A function whose error set can change silently
is a function whose contract cannot be analyzed — by humans, by
compilers, or by agents. Declare them; compose them; switch
exhaustively; rebuild that discipline whenever you see it slipping.
