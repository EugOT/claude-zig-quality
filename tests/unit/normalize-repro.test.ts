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
