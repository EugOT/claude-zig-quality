# Migration Cheatsheet — Zig 0.14 / 0.15 → 0.16

One-page row table. Each row is `old → new + one-line rationale`.
Deeper rules live in the references; this file is the fast scan when
diffing code that predates 0.16. For canonical citations, cross the
row against `../references/0.16-grounded-facts.md`.

| # | Old (0.14 / 0.15) | New (0.16) | Rationale |
|---|---|---|---|
| 1 | `var l = std.ArrayList(T).init(allocator);` | `var l: std.ArrayList(T) = .empty;` | Unmanaged-only; allocator goes to methods. |
| 2 | `l.append(v);` | `try l.append(allocator, v);` | Per-method allocator; matches unmanaged migration. |
| 3 | `l.deinit();` | `l.deinit(allocator);` | Same allocator that grew the list must release it. |
| 4 | `std.heap.GeneralPurposeAllocator(.{})` | `std.heap.DebugAllocator(.{})` | Rename. GPA identity is now explicitly "debug" tier. |
| 5 | `std.heap.ThreadSafeAllocator` wrapper | remove wrapper; use `ArenaAllocator` | `ArenaAllocator` is lock-free; wrapper declared anti-pattern. |
| 6 | `std.fs.cwd().openFile(path, .{})` | `dir.openFile(io, path, .{})` via Juicy Main preopens | `cwd()` removed; `Io` and `Dir` are injected. |
| 7 | `file.close()` | `file.close(io)` | All file ops take `io` in 0.16. |
| 8 | `file.reader(buffer)` | `file.reader(io, buffer)` (or `deprecatedReader`) | Writer/Reader consolidation; old form marked deprecated. |
| 9 | `std.fs.File.*` | `std.Io.File.*` | File types moved to `std.Io`. |
| 10 | `std.Thread.Pool` | `std.Io.async(io, fn, args)` → `Future(T)` | Thread pool replaced by `Io.async`. |
| 11 | `std.Thread.Mutex` | `std.Io.Mutex` | Concurrency primitives moved under `std.Io`. |
| 12 | `std.Thread.WaitGroup` | `std.Io.Group` | Structured concurrency; auto-joins on scope exit. |
| 13 | `std.once(...)` | `std.Io.async` with `Once` semantics | `std.once` removed. |
| 14 | `std.Thread.Mutex.Recursive` | none (removed) | Recursive locking is usually a design bug. |
| 15 | `std.posix.getenv("X")` | `init.environ_map.get("X")` | Juicy Main; env is a parameter, not a global. |
| 16 | `std.process.argsAlloc(gpa)` | iterate `init.minimal.args` | Args come from `std.process.Init`, not allocation. |
| 17 | `std.os.argv` / `std.os.environ` | removed | Route through `init`; see grounded facts row 7. |
| 18 | `std.io.Writer` | `std.Io.Writer` (non-generic; buffer in interface) | Writer consolidation; buffer passed at construction. |
| 19 | `GenericReader` / `AnyReader` / `FixedBufferStream` / `null_writer` / `CountingReader` | `std.Io.Reader.fixed(slice)` / `std.Io.Writer.fixed(buf)` | Removed; single fixed-slice API. |
| 20 | `std.fmt.format(writer, ...)` | `writer.print(...)` | `format` is now a method on `std.Io.Writer`. |
| 21 | `std.fmt.FormatOptions` | `std.fmt.Options` | Rename. |
| 22 | `std.fmt.bufPrintZ(...)` | `std.fmt.bufPrintSentinel(...)` | Rename. |
| 23 | `@intFromFloat(x)` | `@trunc/@floor/@ceil/@round` with target type | `@intFromFloat` deprecated; choose rounding explicitly. |
| 24 | `@Type(.{ .@"struct" = ... })` | `@Struct(layout, backing_int, names, types, attrs)` | Dedicated builtin. `@Type` removed. |
| 25 | `@Type(.{ .int = ... })` | `@Int(.unsigned, 32)` | Dedicated builtin. |
| 26 | `@Type(.{ .error_set = ... })` | not possible | Error sets are not reifiable in 0.16. |
| 27 | `@cImport(...)` in `.zig` source | `b.addTranslateC(...)` in `build.zig` | Deprecated at source level. |
| 28 | `*u8` interchangeably with `*align(1) u8` | insert explicit `@alignCast` / align declarations | Pointer alignment is part of the type now. |
| 29 | `error.RenameAcrossMountPoints` / `NotSameFileSystem` | `error.CrossDevice` | Error-name consolidation. |
| 30 | `error.SharingViolation` | `error.FileBusy` | Error-name consolidation. |
| 31 | `error.EnvironmentVariableNotFound` | `error.EnvironmentVariableMissing` | Error-name consolidation. |
| 32 | `std.BoundedArray(T, N)` | fixed-size backing array + explicit length | `BoundedArray` removed. |
| 33 | `std.fifo.LinearFifo(...)` | `std.Io.Queue(T)` or hand-rolled ring over a slice | `LinearFifo` removed. |
| 34 | `b.addExecutable(.{ .root_source_file = ... })` | module API: `b.createModule` + `root_module` | `root_source_file` on `addExecutable` removed. |
| 35 | `build.zig.zon` without `fingerprint` | add `fingerprint` field | Missing fingerprint is a hard build error in 0.16. |
| 36 | ad-hoc override of a dep by editing zon | `zig build --fork=[path]` | Verified CLI override by name + fingerprint. |
| 37 | global cache usage only | `zig-pkg/` project-local cache next to `build.zig` | Project-local cache is the 0.16 default. |
| 38 | `--prominent-compile-errors` | `--error-style=...` / `--multiline-errors=...` | Replaced by structured flags. |
| 39 | no per-test timeout | `--test-timeout 30000` | Per-test real-time kill-and-restart. |
| 40 | `std.time.Instant` / `Timer` / `timestamp` | `std.Io.Timestamp` via `.now(io)` | Time is now injected through `io`. |
| 41 | `std.crypto.random.bytes(buf)` | `io.random(buf)` / `io.randomSecure(buf)` | Randomness flows through injected `io`. |
| 42 | implicit allocator on struct field | explicit `Allocator` parameter on `pub fn` | Hidden allocators are a design smell in 0.16. |
| 43 | module-level `var` in library files | scoped owner type + `init(gpa)` | No globals outside `main.zig` / `build.zig`. |
| 44 | `anyerror` on public API | declared named error set | Precise error set is part of the public type. |
| 45 | `else =>` branch on public error switch | exhaustive arms | Compiler-enforced update when upstream adds variants. |
| 46 | `catch unreachable` on I/O | `catch |err| ...` with real handling | I/O can always fail; `unreachable` is UB in release. |
