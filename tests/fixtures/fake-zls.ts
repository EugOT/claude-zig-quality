#!/usr/bin/env bun
/**
 * fake-zls.ts — minimal LSP server over stdio for functional tests.
 *
 * Speaks just enough of the LSP wire protocol to exercise
 * collectZlsDiagnostics() in scripts/lib/zls.ts under controlled conditions.
 *
 * CRITICAL: uses the PRODUCTION __test.frame encoder from scripts/lib/zls.ts
 * so the framing cannot drift from the code under test.
 *
 * Behaviour is selected by FAKE_ZLS_MODE env var:
 *
 *   default          publish one valid publishDiagnostics per didOpen
 *   malformed-header emit a bad Content-Length frame first, then a valid one
 *   partial-body     write the body in two chunks with a small delay
 *   one-of-two       only publish for the FIRST of two opened files
 *   never-publish    open a file but never publish + sleep until killed
 *   stderr-flood     write 200 KB to stderr then publish normally
 *   double-publish   publish twice per file (second overwrites first)
 *
 * Untrusted-data boundary: this fixture is test infrastructure only —
 * never imported from production code.
 */

import { __test } from "../../scripts/lib/zls.ts";

const { frame } = __test;

// ---------------------------------------------------------------------------
// Wire-protocol helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Write a framed LSP message to stdout. */
async function send(msg: unknown): Promise<void> {
  const bytes = frame(msg);
  await Bun.stdout.write(bytes);
}

/**
 * Write a LSP frame whose Content-Length header is deliberately wrong.
 * The header says "1" but the body is a full JSON object, so a parser
 * that trusts the length will mis-slice it.
 */
async function sendMalformedHeader(): Promise<void> {
  const body = encoder.encode(JSON.stringify({ jsonrpc: "2.0", method: "bad" }));
  // Claim length=1 while the real body is much larger.
  const header = encoder.encode("Content-Length: 1\r\n\r\n");
  const out = new Uint8Array(header.length + body.length);
  out.set(header, 0);
  out.set(body, header.length);
  await Bun.stdout.write(out);
}

/**
 * Write a framed LSP message split across two stdout writes with a small
 * delay between them, simulating a slow/partial delivery.
 */
async function sendPartial(msg: unknown): Promise<void> {
  const bytes = frame(msg);
  // Split after the header (find \r\n\r\n) so the body arrives in two parts.
  let sep = -1;
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (
      bytes[i] === 13 &&
      bytes[i + 1] === 10 &&
      bytes[i + 2] === 13 &&
      bytes[i + 3] === 10
    ) {
      sep = i + 4;
      break;
    }
  }
  if (sep < 0) {
    // Fallback: split in the middle of the whole frame.
    sep = Math.floor(bytes.length / 2);
  }
  const part1 = bytes.slice(0, sep);
  const part2 = bytes.slice(sep);
  await Bun.stdout.write(part1);
  // Small delay — enough for the reader loop to see the partial buffer.
  await Bun.sleep(30);
  await Bun.stdout.write(part2);
}

// ---------------------------------------------------------------------------
// Incoming frame parser (minimal — just enough for the fixture)
// ---------------------------------------------------------------------------

interface LspMessage {
  id?: number;
  method?: string;
  params?: {
    textDocument?: { uri?: string; text?: string };
  };
}

/** Read exactly n bytes from stdin. */
async function readExact(n: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let collected = 0;
  const reader = Bun.stdin.stream().getReader();
  while (collected < n) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      collected += value.length;
    }
  }
  reader.releaseLock();
  // Concatenate and return exactly n bytes.
  const all = new Uint8Array(collected);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.length;
  }
  return all.slice(0, n);
}

/** Read LSP frames from stdin indefinitely, yielding parsed messages. */
async function* readFrames(): AsyncGenerator<LspMessage> {
  let buf = new Uint8Array(0);
  const reader = Bun.stdin.stream().getReader();

  try {
    for (;;) {
      // Try to drain the buffer first, then read more.
      for (;;) {
        // Find \r\n\r\n header separator.
        let sep = -1;
        for (let i = 0; i + 3 < buf.length; i++) {
          if (
            buf[i] === 13 &&
            buf[i + 1] === 10 &&
            buf[i + 2] === 13 &&
            buf[i + 3] === 10
          ) {
            sep = i;
            break;
          }
        }
        if (sep < 0) break; // need more data

        const headText = decoder.decode(buf.slice(0, sep));
        const m = headText.match(/Content-Length:\s*(\d+)/i);
        if (!m) {
          // Malformed header — skip past this separator and continue.
          buf = buf.slice(sep + 4);
          continue;
        }
        const len = Number(m[1]);
        const bodyStart = sep + 4;
        if (buf.length < bodyStart + len) break; // body not complete yet

        const raw = decoder.decode(buf.slice(bodyStart, bodyStart + len));
        buf = buf.slice(bodyStart + len);

        try {
          yield JSON.parse(raw) as LspMessage;
        } catch {
          // Non-JSON noise — ignore.
        }
      }

      // Need more bytes.
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        const next = new Uint8Array(buf.length + value.length);
        next.set(buf, 0);
        next.set(value, buf.length);
        buf = next;
      }
    }
  } catch {
    // Stdin closed / process killed — expected.
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Mode-specific diagnostic payloads
// ---------------------------------------------------------------------------

function makeDiag(msg: string, severity: number = 1) {
  return {
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 },
    },
    severity,
    message: msg,
  };
}

function publishDiag(uri: string, diags: unknown[]) {
  return {
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: { uri, diagnostics: diags },
  };
}

// ---------------------------------------------------------------------------
// Main LSP server loop
// ---------------------------------------------------------------------------

// Mode can be passed as argv[2] (preferred — survives Bun.spawn env isolation)
// or via FAKE_ZLS_MODE env var (fallback for direct invocation).
const MODE = process.argv[2] ?? process.env.FAKE_ZLS_MODE ?? "default";

// Track opened URIs in order so we can implement one-of-two.
const openedUris: string[] = [];
let initialized = false;

for await (const msg of readFrames()) {
  const method = msg.method ?? "";
  const id = msg.id;

  if (method === "initialize") {
    if (MODE === "malformed-header" && !initialized) {
      // Emit a malformed-header frame first, then the proper response.
      await sendMalformedHeader();
    }
    initialized = true;

    if (MODE === "partial-body") {
      // Send the initialize response body in two partial writes.
      await sendPartial({
        jsonrpc: "2.0",
        id,
        result: { capabilities: { textDocumentSync: 1 } },
      });
    } else {
      await send({
        jsonrpc: "2.0",
        id,
        result: { capabilities: { textDocumentSync: 1 } },
      });
    }

    if (MODE === "stderr-flood") {
      // Flood stderr with 200 KB. Do this after initialize so the client
      // has a response to act on; the drain loop must consume this without
      // deadlocking.
      const chunk = "X".repeat(1024); // 1 KB
      for (let i = 0; i < 200; i++) {
        process.stderr.write(chunk);
      }
    }
    continue;
  }

  if (method === "initialized") {
    // No response needed for the initialized notification.
    continue;
  }

  if (method === "textDocument/didOpen") {
    const uri = msg.params?.textDocument?.uri ?? "";
    if (!uri) continue;
    openedUris.push(uri);

    switch (MODE) {
      case "never-publish":
        // Never publish — just sleep until the process is killed.
        // The hard timeout in collectZlsDiagnostics will fire.
        await Bun.sleep(60_000);
        break;

      case "one-of-two":
        // Only publish for the first opened URI; the second is never reported.
        if (openedUris.length === 1) {
          await send(publishDiag(uri, [makeDiag("one-of-two error")]));
        }
        // Second URI: never publish → lands in unreported.
        break;

      case "stderr-flood":
        // stderr was already flooded after initialize — just publish normally.
        await send(publishDiag(uri, [makeDiag("stderr-flood diag")]));
        break;

      case "double-publish": {
        // Publish twice: first with one diagnostic, then immediately overwrite.
        const first = [makeDiag("first-publish diag", 2)]; // warning
        const second = [makeDiag("second-publish diag", 1)]; // error
        await send(publishDiag(uri, first));
        // Small yield to let the reader loop pick up the first push.
        await Bun.sleep(10);
        await send(publishDiag(uri, second));
        break;
      }

      case "malformed-header":
        // Already sent the malformed frame before the initialize response.
        // Now publish a valid diagnostics notification.
        await send(publishDiag(uri, [makeDiag("post-malformed diag")]));
        break;

      case "partial-body":
        // Send the publishDiagnostics body split across two writes.
        await sendPartial(publishDiag(uri, [makeDiag("partial-body diag")]));
        break;

      default:
        // Normal: publish one clean diagnostics notification.
        await send(publishDiag(uri, [makeDiag("fake-zls error")]));
        break;
    }
    continue;
  }

  if (method === "shutdown") {
    await send({ jsonrpc: "2.0", id, result: null });
    continue;
  }

  if (method === "exit") {
    // LSP spec: exit with 0 after shutdown, 1 if not shut down.
    // ZLS exits 1 even on clean shutdown; match that to test the
    // production code's "don't rely on exit code" contract.
    process.exit(1);
  }
}
