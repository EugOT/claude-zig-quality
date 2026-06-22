/**
 * Unit tests for .claude/hooks/posttooluse-zig.ts — BANNED_API regex layer.
 *
 * STRATEGY: Import BANNED_API directly and test each regex in-process.
 * No subprocess needed — all assertions are pure JS regex matching.
 * Functional / subprocess tests live in tests/functional/posttool-zig.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { BANNED_API } from "../../.claude/hooks/posttooluse-zig.ts";

// ---------------------------------------------------------------------------
// Core helper — mirrors the hook's inner loop: block if ANY pattern matches.
// ---------------------------------------------------------------------------
const banned = (s: string): boolean => BANNED_API.some(({ re }) => re.test(s));

// ---------------------------------------------------------------------------
// Helper: return the fix string for the first matching pattern (if any).
// ---------------------------------------------------------------------------
const bannedFix = (s: string): string | undefined =>
  BANNED_API.find(({ re }) => re.test(s))?.fix;

// ===========================================================================
// BANNED_API regex tests
// ===========================================================================
describe("BANNED_API regex layer", () => {
  // -------------------------------------------------------------------------
  // (1) std.heap.GeneralPurposeAllocator — fires on exact name
  // -------------------------------------------------------------------------
  test("(1) 'std.heap.GeneralPurposeAllocator' fires", () => {
    expect(banned("var gpa = std.heap.GeneralPurposeAllocator(.{}){};\n")).toBe(
      true,
    );
    // Word-boundary: 'GeneralPurposeAllocatorX' must NOT fire.
    expect(banned("std.heap.GeneralPurposeAllocatorX")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // (2) ArrayList(MemoryRegion).init( — multi-char type name regression
  // -------------------------------------------------------------------------
  test("(2) 'ArrayList(MemoryRegion).init(' fires (multi-char type name)", () => {
    expect(
      banned("var list = ArrayList(MemoryRegion).init(alloc);\n"),
    ).toBe(true);
    // Confirm the fix message is the 0.16 idiom
    expect(bannedFix("ArrayList(MemoryRegion).init(alloc)")).toContain(".empty");
  });

  // -------------------------------------------------------------------------
  // (3) ArrayList(u8) WITHOUT .init does NOT fire
  // -------------------------------------------------------------------------
  test("(3) 'ArrayList(u8)' without .init does NOT fire", () => {
    expect(banned("var list: ArrayList(u8) = .empty;\n")).toBe(false);
    expect(banned("try list.append(alloc, 42);\n")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // (4) std.io.getStdOut() fires
  // -------------------------------------------------------------------------
  test("(4) 'std.io.getStdOut()' fires", () => {
    expect(
      banned("const stdout = std.io.getStdOut().writer();\n"),
    ).toBe(true);
    // Also fires with whitespace before the paren (the regex uses \s*)
    expect(banned("std.io.getStdOut  ()")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // (5) Thread.Pool fires
  // -------------------------------------------------------------------------
  test("(5) 'Thread.Pool' fires", () => {
    expect(banned("var pool = Thread.Pool.init(.{});\n")).toBe(true);
    // Word-boundary: 'Thread.Pooling' must NOT fire.
    expect(banned("Thread.Pooling")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // (6) usingnamespace fires; 'not_usingnamespace' does NOT fire (word boundary)
  // -------------------------------------------------------------------------
  test("(6a) 'usingnamespace' fires", () => {
    expect(banned("usingnamespace std.meta;\n")).toBe(true);
  });

  test("(6b) 'not_usingnamespace' does NOT fire (word boundary)", () => {
    // The pattern is /\busingnamespace\b/ — must not fire when preceded by '_'
    // (non-word char boundary) because underscore IS a word char in JS regex.
    // Actually \b fires between a non-word and a word char, so a leading letter
    // or digit or underscore adjacent to 'usingnamespace' suppresses the match.
    expect(banned("not_usingnamespace")).toBe(false);
    expect(banned("x_usingnamespace")).toBe(false);
    // A space-separated prefix does fire because the space is a non-word char.
    expect(banned("pub usingnamespace std.meta;")).toBe(true);
  });
});

// ===========================================================================
// Non-blocking extension / structural tests
// ===========================================================================
describe("BANNED_API export shape", () => {
  test("exports exactly 5 entries", () => {
    expect(BANNED_API).toHaveLength(5);
  });

  test("every entry has a RegExp re and a non-empty fix string", () => {
    for (const { re, fix } of BANNED_API) {
      expect(re).toBeInstanceOf(RegExp);
      expect(typeof fix).toBe("string");
      expect(fix.length).toBeGreaterThan(0);
    }
  });

  test("fix strings reference version guidance (0.15 or 0.16)", () => {
    for (const { fix } of BANNED_API) {
      // Every fix must mention at least one version anchor so the developer
      // knows which migration applies. usingnamespace says "0.15.1+";
      // all other entries say "0.16".
      const hasVersion = fix.includes("0.16") || fix.includes("0.15");
      expect(hasVersion).toBe(true);
    }
  });
});
