/**
 * Tests for `normalizeForRepro` (verify-release.ts Phase 1).
 *
 * macOS builds are not byte-reproducible: the linker stamps a random LC_UUID
 * per link (and derives the __LINKEDIT signature/symtab from it), so two clean
 * rebuilds of identical source differ. Empirically, the ONLY non-deterministic
 * bytes in the loadable image are the 16-byte LC_UUID payload; code + data are
 * identical. `normalizeForRepro` hashes only the loadable segments (excluding
 * __LINKEDIT) with the UUID zeroed, yielding a deterministic digest of the
 * real program image. These tests build a synthetic Mach-O so the contract is
 * verified without spawning a real `zig build`.
 */
import { expect, test } from "bun:test";
import { normalizeForRepro } from "../../scripts/verify-release.ts";

const MH_MAGIC_64 = 0xfeedfacf;
const LC_SEGMENT_64 = 0x19;
const LC_UUID = 0x1b;

/**
 * Build a minimal 64-bit little-endian Mach-O with:
 *   - mach_header_64 (ncmds = 3)
 *   - LC_SEGMENT_64 "__TEXT" covering the whole file (deterministic body)
 *   - LC_UUID with the given 16-byte uuid (the non-deterministic part)
 *   - LC_SEGMENT_64 "__LINKEDIT" (excluded from the repro hash)
 * The __LINKEDIT body is filled with `linkeditFill` so we can prove it does
 * NOT affect the normalized digest.
 */
function synthMachO(uuid: number[], linkeditFill: number): Uint8Array {
	const headerSize = 32;
	const segCmdSize = 72; // sizeof(segment_command_64)
	const uuidCmdSize = 24; // 8 hdr + 16 payload
	const cmdsTotal = segCmdSize + uuidCmdSize + segCmdSize;
	const bodyStart = headerSize + cmdsTotal;
	const textBody = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]); // deterministic
	const linkeditBody = new Uint8Array(8).fill(linkeditFill);
	const total = bodyStart + textBody.byteLength + linkeditBody.byteLength;
	const buf = new Uint8Array(total);
	const dv = new DataView(buf.buffer);
	const enc = new TextEncoder();

	dv.setUint32(0, MH_MAGIC_64, true); // magic
	dv.setUint32(16, 3, true); // ncmds
	dv.setUint32(20, cmdsTotal, true); // sizeofcmds

	let o = headerSize;
	// __TEXT segment (loadable, deterministic). Like a real Mach-O, __TEXT
	// starts at file offset 0 and covers the header + load commands (where
	// LC_UUID physically lives) through the end of the text body. This is
	// what makes the LC_UUID bytes fall INSIDE the range normalizeForRepro()
	// hashes — so the "different UUIDs normalize equal" test actually
	// exercises the UUID-zeroing, not a region outside the hash (CodeRabbit).
	dv.setUint32(o, LC_SEGMENT_64, true);
	dv.setUint32(o + 4, segCmdSize, true);
	buf.set(enc.encode("__TEXT"), o + 8);
	dv.setBigUint64(o + 40, 0n, true); // fileoff = 0 (covers header + cmds)
	dv.setBigUint64(o + 48, BigInt(bodyStart + textBody.byteLength), true); // filesize
	o += segCmdSize;
	// LC_UUID (non-deterministic)
	dv.setUint32(o, LC_UUID, true);
	dv.setUint32(o + 4, uuidCmdSize, true);
	buf.set(Uint8Array.from(uuid), o + 8);
	o += uuidCmdSize;
	// __LINKEDIT segment (excluded from repro hash)
	dv.setUint32(o, LC_SEGMENT_64, true);
	dv.setUint32(o + 4, segCmdSize, true);
	buf.set(enc.encode("__LINKEDIT"), o + 8);
	dv.setBigUint64(o + 40, BigInt(bodyStart + textBody.byteLength), true);
	dv.setBigUint64(o + 48, BigInt(linkeditBody.byteLength), true);

	buf.set(textBody, bodyStart);
	buf.set(linkeditBody, bodyStart + textBody.byteLength);
	return buf;
}

const hex = (b: Uint8Array) =>
	new Bun.CryptoHasher("sha256").update(b).digest("hex");

test("Mach-O builds differing only in LC_UUID normalize to the same digest", () => {
	const a = synthMachO([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], 0xaa);
	const b = synthMachO([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 1, 2, 3, 4, 5, 6], 0xaa);
	expect(hex(a)).not.toBe(hex(b)); // raw bytes differ (UUID)
	expect(hex(normalizeForRepro(a))).toBe(hex(normalizeForRepro(b))); // normalized: equal
});

test("__LINKEDIT differences do not affect the normalized digest", () => {
	const uuid = [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2];
	const a = synthMachO(uuid, 0x11);
	const b = synthMachO(uuid, 0xff); // only __LINKEDIT body differs
	expect(hex(a)).not.toBe(hex(b));
	expect(hex(normalizeForRepro(a))).toBe(hex(normalizeForRepro(b)));
});

test("a genuine __TEXT difference still changes the normalized digest", () => {
	// Tamper a loadable byte: normalization must NOT mask real drift.
	const uuid = [3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3];
	const a = synthMachO(uuid, 0x00);
	const b = synthMachO(uuid, 0x00);
	expect(hex(normalizeForRepro(a))).toBe(hex(normalizeForRepro(b))); // baseline equal
	b[b.byteLength - 8 - 8] ^= 0xff; // flip a byte inside __TEXT body
	expect(hex(normalizeForRepro(a))).not.toBe(hex(normalizeForRepro(b)));
});

test("non-Mach-O input passes through unchanged", () => {
	const elfish = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3, 4, 5, 6]);
	expect(normalizeForRepro(elfish)).toEqual(elfish);
	const tiny = new Uint8Array([1, 2, 3]);
	expect(normalizeForRepro(tiny)).toEqual(tiny);
});

// ── New cases (plan §9) ─────────────────────────────────────────────────────

test("does NOT mutate the input buffer — original bytes survive normalization", () => {
	const uuid = [0xde, 0xad, 0xbe, 0xef, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff];
	const original = synthMachO(uuid, 0xcc);
	// Snapshot a byte that lives inside the LC_UUID payload region.
	// The LC_UUID is the second load command: header(32) + segCmd(72) = offset 104.
	// UUID payload starts at offset 104 + 8 = 112.
	const snapshotByte = original[112];
	normalizeForRepro(original);
	// The function must return a copy; the input must be untouched.
	expect(original[112]).toBe(snapshotByte);
	expect(original[112]).not.toBe(0); // sanity: the UUID byte was non-zero
});

test("cmdsize overflow guard: truncated load command does not throw", () => {
	// Build a Mach-O header that advertises ncmds=5 but the buffer is only
	// 32 + 8 bytes (one partial LC header). The guard `cmdsize < 8 || nextOff >
	// buf.byteLength` must break out of the loop cleanly.
	const buf = new Uint8Array(40);
	const dv = new DataView(buf.buffer);
	dv.setUint32(0, MH_MAGIC_64, true); // valid magic
	dv.setUint32(16, 5, true);           // ncmds = 5 (too many for the buffer)
	// Write a cmdsize that would overflow: 0xffffffff
	dv.setUint32(32, LC_SEGMENT_64, true);
	dv.setUint32(36, 0xffffffff, true);  // cmdsize overflow
	expect(() => normalizeForRepro(buf)).not.toThrow();
	// Falls back to returning a copy (parts.length===0 path) — result is Uint8Array.
	const result = normalizeForRepro(buf);
	expect(result).toBeInstanceOf(Uint8Array);
});

test("ncmds=0 returns a copy of the input (no segments to collect)", () => {
	// A valid Mach-O header with ncmds=0: no load commands, no segments.
	// parts.length will be 0, so the fallback `return buf` (a copy) applies.
	const buf = new Uint8Array(32);
	const dv = new DataView(buf.buffer);
	dv.setUint32(0, MH_MAGIC_64, true); // valid magic
	dv.setUint32(16, 0, true);           // ncmds = 0
	const result = normalizeForRepro(buf);
	expect(result).toBeInstanceOf(Uint8Array);
	expect(result.byteLength).toBe(32);
	// Must be a copy, not the same reference.
	expect(result).not.toBe(buf);
	// Content is identical (no mutation, no transformation).
	expect(result).toEqual(buf);
});

test("LC_SEGMENT_64 with filesize=0 is excluded from the output parts", () => {
	// Build a Mach-O with one segment whose filesize=0 and one with filesize>0.
	// After normalization, only the filesize>0 segment contributes to the output.
	const headerSize = 32;
	const segCmdSize = 72;
	// Two LC_SEGMENT_64 commands: "__ZERO" (filesize=0) and "__TEXT" (filesize>0).
	const cmdsTotal = segCmdSize * 2;
	const bodyStart = headerSize + cmdsTotal;
	const textBody = new Uint8Array([0x41, 0x42, 0x43, 0x44]); // "ABCD"
	const total = bodyStart + textBody.byteLength;
	const buf = new Uint8Array(total);
	const dv = new DataView(buf.buffer);
	const enc = new TextEncoder();

	dv.setUint32(0, MH_MAGIC_64, true);
	dv.setUint32(16, 2, true);           // ncmds = 2
	dv.setUint32(20, cmdsTotal, true);

	// __ZERO segment: filesize = 0 (must be excluded).
	let o = headerSize;
	dv.setUint32(o, LC_SEGMENT_64, true);
	dv.setUint32(o + 4, segCmdSize, true);
	buf.set(enc.encode("__ZERO"), o + 8);
	dv.setBigUint64(o + 40, BigInt(bodyStart), true); // fileoff
	dv.setBigUint64(o + 48, 0n, true);                // filesize = 0 → excluded
	o += segCmdSize;

	// __TEXT segment: filesize > 0 (must be included).
	dv.setUint32(o, LC_SEGMENT_64, true);
	dv.setUint32(o + 4, segCmdSize, true);
	buf.set(enc.encode("__TEXT"), o + 8);
	dv.setBigUint64(o + 40, BigInt(bodyStart), true);
	dv.setBigUint64(o + 48, BigInt(textBody.byteLength), true);
	buf.set(textBody, bodyStart);

	const result = normalizeForRepro(buf);
	// Result must be shorter than the full buffer (only __TEXT contributed).
	// It should contain the segname+size framing + textBody, not the full file.
	expect(result.byteLength).toBeLessThan(buf.byteLength);
	// The __TEXT body bytes must appear somewhere in the result.
	const resultHex = Buffer.from(result).toString("hex");
	const bodyHex = Buffer.from(textBody).toString("hex");
	expect(resultHex).toContain(bodyHex);
});

test("parts.length===0 (no loadable segments) returns full-buffer copy as fallback", () => {
	// A Mach-O with only __LINKEDIT (excluded) and __PAGEZERO (excluded).
	// Both are in REPRO_EXCLUDE_SEGMENTS so parts stays empty → fallback to `buf`.
	const headerSize = 32;
	const segCmdSize = 72;
	const cmdsTotal = segCmdSize * 2;
	const bodyStart = headerSize + cmdsTotal;
	const body = new Uint8Array([0xff, 0xfe, 0xfd]);
	const total = bodyStart + body.byteLength;
	const buf = new Uint8Array(total);
	const dv = new DataView(buf.buffer);
	const enc = new TextEncoder();

	dv.setUint32(0, MH_MAGIC_64, true);
	dv.setUint32(16, 2, true);
	dv.setUint32(20, cmdsTotal, true);

	let o = headerSize;
	// __PAGEZERO (excluded)
	dv.setUint32(o, LC_SEGMENT_64, true);
	dv.setUint32(o + 4, segCmdSize, true);
	buf.set(enc.encode("__PAGEZERO"), o + 8);
	dv.setBigUint64(o + 40, BigInt(bodyStart), true);
	dv.setBigUint64(o + 48, BigInt(body.byteLength), true);
	o += segCmdSize;

	// __LINKEDIT (excluded)
	dv.setUint32(o, LC_SEGMENT_64, true);
	dv.setUint32(o + 4, segCmdSize, true);
	buf.set(enc.encode("__LINKEDIT"), o + 8);
	dv.setBigUint64(o + 40, BigInt(bodyStart), true);
	dv.setBigUint64(o + 48, BigInt(body.byteLength), true);
	buf.set(body, bodyStart);

	const result = normalizeForRepro(buf);
	// Fallback: result equals the full copy (same length and content as buf).
	expect(result.byteLength).toBe(buf.byteLength);
	expect(result).toEqual(buf);
	// Must still be a copy, not the original reference.
	expect(result).not.toBe(buf);
});
