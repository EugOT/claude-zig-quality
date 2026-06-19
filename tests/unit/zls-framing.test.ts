/**
 * Tests for the ZLS LSP wire-framing helpers in scripts/lib/zls.ts.
 *
 * These cover the protocol-correctness invariants that are cheap to verify
 * without spawning ZLS — the parts that, if wrong, silently corrupt every
 * message (the research flagged byte-length framing as the #1 footgun):
 *
 *   - Content-Length must be the exact UTF-8 BYTE length, not the JS string
 *     (UTF-16) length, so multibyte content frames correctly.
 *   - The header/body separator is `\r\n\r\n`.
 *   - A round-trip (frame → parse) recovers the original message, including
 *     across a buffer that carries two concatenated frames.
 *
 * The live end-to-end path (spawn ZLS, didOpen, collect diagnostics) is
 * exercised by scripts/zls-check.ts against the pinned binary in the per-PR
 * gate; it is not unit-tested here because it needs the real server.
 */
import { expect, test } from "bun:test";
import { __test } from "../../scripts/lib/zls.ts";

const { frame, headerEnd } = __test;
const decoder = new TextDecoder();

function parseFirst(buf: Uint8Array): { body: unknown; rest: Uint8Array } {
	const sep = headerEnd(buf);
	expect(sep).toBeGreaterThanOrEqual(0);
	const head = decoder.decode(buf.slice(0, sep));
	const m = head.match(/Content-Length:\s*(\d+)/i);
	expect(m).not.toBeNull();
	const len = Number((m as RegExpMatchArray)[1]);
	const start = sep + 4;
	const body = JSON.parse(decoder.decode(buf.slice(start, start + len)));
	return { body, rest: buf.slice(start + len) };
}

test("frame uses exact UTF-8 byte length, not string length", () => {
	// 'é' is 1 UTF-16 code unit but 2 UTF-8 bytes; a naive .length would
	// under-count and truncate the body.
	const msg = { method: "x", text: "café — naïve ☃" };
	const framed = frame(msg);
	const head = decoder.decode(framed.slice(0, headerEnd(framed)));
	const declared = Number(
		(head.match(/Content-Length:\s*(\d+)/i) as RegExpMatchArray)[1],
	);
	const actualBodyBytes = new TextEncoder().encode(JSON.stringify(msg)).length;
	expect(declared).toBe(actualBodyBytes);
	// And the JS string length must be DIFFERENT here (proves the bug would bite).
	expect(declared).not.toBe(JSON.stringify(msg).length);
});

test("frame → parse round-trips a message", () => {
	const msg = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
	const { body, rest } = parseFirst(frame(msg));
	expect(body).toEqual(msg);
	expect(rest.length).toBe(0);
});

test("two concatenated frames parse independently", () => {
	const a = { jsonrpc: "2.0", id: 1, method: "initialize" };
	const b = {
		jsonrpc: "2.0",
		method: "textDocument/didOpen",
		params: { uri: "file:///x.zig" },
	};
	const fa = frame(a);
	const fb = frame(b);
	const both = new Uint8Array(fa.length + fb.length);
	both.set(fa, 0);
	both.set(fb, fa.length);

	const first = parseFirst(both);
	expect(first.body).toEqual(a);
	const second = parseFirst(first.rest);
	expect(second.body).toEqual(b);
	expect(second.rest.length).toBe(0);
});

test("headerEnd returns -1 until the full separator has arrived", () => {
	expect(headerEnd(new TextEncoder().encode("Content-Length: 5\r\n"))).toBe(-1);
	const full = new TextEncoder().encode("Content-Length: 5\r\n\r\nhello");
	expect(headerEnd(full)).toBeGreaterThanOrEqual(0);
});
