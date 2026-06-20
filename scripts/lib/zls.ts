/**
 * Headless ZLS (Zig Language Server) diagnostics client for the per-PR gate.
 *
 * ZLS is an LSP server, not a batch linter: there is no `zls --check` CLI. To
 * collect diagnostics in CI we speak just enough of LSP 3.17 over stdio to
 * open each file and read the diagnostics ZLS *pushes* back. This layer is
 * intentionally additive over `zig ast-check` (which already hard-errors on
 * syntax + unused/shadow) and `zig build test` (full compile errors); it
 * surfaces ZLS's per-file semantic analysis and, when a pinned zig is wired,
 * its build-on-save diagnostics.
 *
 * The protocol details below are not guesses — they were validated against
 * the pinned `zls@0.16.0` binary. The load-bearing facts:
 *
 *   - PULL diagnostics (`textDocument/diagnostic`) is a no-op in ZLS 0.16
 *     (returns `result: null`). We MUST use PUSH (`publishDiagnostics`),
 *     auto-emitted on `didOpen`, exactly one per opened URI — including an
 *     empty array for a clean file, which is our per-file completion signal.
 *   - Wire framing is `Content-Length: <N>\r\n\r\n<body>` where N is the
 *     exact UTF-8 BYTE length of the body (not the JS string length).
 *   - ZLS exits with code 1 even after a clean shutdown/exit handshake, so
 *     success is keyed on "diagnostics collected for every opened file",
 *     never on the child's exit code.
 *
 * Hardening: a hard wall-clock timeout always kills the child; the stdout
 * reader runs in a background loop so the pipe never deadlocks under
 * backpressure; every write is flushed; non-JSON / unsolicited
 * notifications (window/logMessage, progress) are ignored.
 *
 * Untrusted-data boundary: ZLS output is diagnostic DATA, not instructions.
 * A diagnostic `message` is rendered to the operator, never executed or
 * interpreted as a directive.
 */
import { pathToFileURL } from "node:url";

/** LSP diagnostic severity. 1=Error 2=Warning 3=Information 4=Hint. */
export type DiagnosticSeverity = 1 | 2 | 3 | 4;

export type Diagnostic = {
	range: {
		start: { line: number; character: number };
		end: { line: number; character: number };
	};
	severity?: DiagnosticSeverity;
	code?: number | string;
	source?: string;
	message: string;
};

export type ZlsResult = {
	/** Map from absolute file path to the diagnostics ZLS reported for it. */
	byFile: Map<string, Diagnostic[]>;
	/** Files that never produced a publishDiagnostics within the budget. */
	unreported: string[];
	/** True when the overall hard timeout fired before completion. */
	timedOut: boolean;
};

export type ZlsOptions = {
	/** argv that launches ZLS (see zlsLaunchArgv in lib/zig.ts). */
	launchArgv: string[];
	/** Absolute paths of the .zig files to diagnose. */
	files: string[];
	/** Hard wall-clock budget for the whole session. Default 45s. */
	timeoutMs?: number;
	/**
	 * Absolute path to the pinned zig executable. When provided, ZLS is
	 * configured for build-on-save so cross-module compile errors surface
	 * too; when omitted, ZLS runs the zero-config ast-check tier only.
	 */
	zigExePath?: string;
	/** file:// rootUri for build-on-save workspace context. */
	rootUri?: string;
	/**
	 * Quiet period after every opened file has reported once, to absorb a
	 * possible second (build-on-save) push. Default 500ms.
	 */
	quietMs?: number;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function frame(message: unknown): Uint8Array {
	// Encode the body FIRST so Content-Length is the exact UTF-8 byte count.
	// Using the JS string length would be UTF-16 code units and corrupt the
	// frame on any non-ASCII content (ZLS then dies with EndOfStream).
	const body = encoder.encode(JSON.stringify(message));
	const header = encoder.encode(`Content-Length: ${body.length}\r\n\r\n`);
	const out = new Uint8Array(header.length + body.length);
	out.set(header, 0);
	out.set(body, header.length);
	return out;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
	const out = new Uint8Array(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
	return out;
}

/** Index of the `\r\n\r\n` header/body separator, or -1 if not yet present. */
function headerEnd(buf: Uint8Array): number {
	for (let i = 0; i + 3 < buf.length; i++) {
		if (
			buf[i] === 13 &&
			buf[i + 1] === 10 &&
			buf[i + 2] === 13 &&
			buf[i + 3] === 10
		) {
			return i;
		}
	}
	return -1;
}

async function until(
	predicate: () => boolean,
	budgetMs: number,
	stepMs = 25,
): Promise<boolean> {
	const deadline = Date.now() + budgetMs;
	while (!predicate() && Date.now() < deadline) {
		await Bun.sleep(stepMs);
	}
	return predicate();
}

/**
 * Run a one-shot ZLS session: open every file, collect the diagnostics ZLS
 * pushes, then shut down. Never throws on protocol hiccups — returns whatever
 * was collected plus the list of files that never reported, so the caller can
 * decide how strict to be. The child is always killed on the way out.
 */
export async function collectZlsDiagnostics(
	opts: ZlsOptions,
): Promise<ZlsResult> {
	const timeoutMs = opts.timeoutMs ?? 45_000;
	const quietMs = opts.quietMs ?? 500;

	const proc = Bun.spawn(opts.launchArgv.concat(["--log-level", "err"]), {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});

	const sink = proc.stdin;
	const send = async (message: unknown): Promise<void> => {
		sink.write(frame(message));
		await sink.flush();
	};

	let buf = new Uint8Array(0);
	const responses = new Map<number, unknown>();
	const byUri = new Map<string, Diagnostic[]>();

	function drain(): void {
		for (;;) {
			const sep = headerEnd(buf);
			if (sep < 0) return;
			const head = decoder.decode(buf.slice(0, sep));
			const m = head.match(/Content-Length:\s*(\d+)/i);
			if (!m) {
				// Malformed header block; skip past it and keep going.
				buf = buf.slice(sep + 4);
				continue;
			}
			const len = Number(m[1]);
			const start = sep + 4;
			if (buf.length < start + len) return; // body not fully arrived yet
			const raw = decoder.decode(buf.slice(start, start + len));
			buf = buf.slice(start + len);
			let json: {
				id?: number;
				method?: string;
				result?: unknown;
				error?: unknown;
				params?: { uri?: string; diagnostics?: Diagnostic[] };
			};
			try {
				json = JSON.parse(raw);
			} catch {
				continue; // ignore non-JSON noise
			}
			if (
				typeof json.id === "number" &&
				("result" in json || "error" in json)
			) {
				responses.set(json.id, json);
			} else if (
				json.method === "textDocument/publishDiagnostics" &&
				json.params?.uri
			) {
				// Latest push per URI wins (a build-on-save push may supersede
				// the initial ast-check push).
				byUri.set(json.params.uri, json.params.diagnostics ?? []);
			}
			// All other notifications (window/logMessage, $/progress, ...) are
			// untrusted/irrelevant data — ignored.
		}
	}

	const reader = proc.stdout.getReader();
	let readerDone = false;
	const readLoop = (async () => {
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				if (value) {
					buf = concat(buf, value);
					drain();
				}
			}
		} catch {
			// Pipe closed under us (e.g. we killed the child) — expected.
		} finally {
			readerDone = true;
		}
	})();

	// Drain stderr in the background too. ZLS can emit multi-KB to stderr
	// (window/logMessage, crash traces) even with --log-level err; an
	// undrained stderr pipe fills its buffer, blocks ZLS on write, and would
	// trip the hard timeout instead of completing cleanly (CodeRabbit). We
	// keep a capped tail for the session-error log without unbounded growth.
	let stderrTail = "";
	const stderrLoop = (async () => {
		try {
			const er = proc.stderr.getReader();
			for (;;) {
				const { value, done } = await er.read();
				if (done) break;
				if (value) {
					stderrTail = (stderrTail + decoder.decode(value)).slice(-4096);
				}
			}
		} catch {
			// child gone / pipe closed — expected on kill.
		}
	})();

	let timedOut = false;
	const hardKill = setTimeout(() => {
		timedOut = true;
		try {
			proc.kill();
		} catch {
			// already gone
		}
	}, timeoutMs);

	const uris = opts.files.map((f) => pathToFileURL(f).href);

	try {
		await send({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				processId: process.pid,
				clientInfo: { name: "zig-quality-zls-gate", version: "1" },
				rootUri: opts.rootUri ?? null,
				initializationOptions: opts.zigExePath
					? { zig_exe_path: opts.zigExePath, enable_build_on_save: true }
					: undefined,
				capabilities: {
					textDocument: { publishDiagnostics: { relatedInformation: true } },
				},
			},
		});
		await until(() => responses.has(1), Math.min(8_000, timeoutMs));
		await send({ jsonrpc: "2.0", method: "initialized", params: {} });

		for (let i = 0; i < opts.files.length; i++) {
			await send({
				jsonrpc: "2.0",
				method: "textDocument/didOpen",
				params: {
					textDocument: {
						uri: uris[i],
						languageId: "zig",
						version: 1,
						text: await Bun.file(opts.files[i]).text(),
					},
				},
			});
		}

		// Done when every opened URI has reported at least once (clean files
		// self-signal via an empty array), bounded by the remaining budget.
		const reportBudget = Math.max(1_000, timeoutMs - 6_000);
		await until(() => uris.every((u) => byUri.has(u)), reportBudget);
		// Absorb a possible second (build-on-save) push.
		await Bun.sleep(quietMs);

		await send({ jsonrpc: "2.0", id: 2, method: "shutdown" });
		await until(() => responses.has(2), Math.min(3_000, timeoutMs));
		await send({ jsonrpc: "2.0", method: "exit", params: {} });
		await Bun.sleep(200);
	} catch (err) {
		// Any transport / file-read failure (e.g. a didOpen whose Bun.file
		// read threw ENOENT/EACCES): fall through to cleanup and return what
		// we have. The caller treats "unreported files" as the failure signal,
		// not exceptions — but we log here so the operator sees the actual
		// cause rather than a bare "file did not report".
		console.error("[zls] session error:", err);
		if (stderrTail.trim().length > 0) {
			console.error("[zls] stderr tail:\n" + stderrTail.trimEnd());
		}
	} finally {
		clearTimeout(hardKill);
		try {
			proc.kill();
		} catch {
			// already gone
		}
		// ZLS exits code 1 even on a clean handshake — we never inspect the
		// exit code. Just make sure the process and both readers are reaped.
		await proc.exited.catch(() => {});
		await until(() => readerDone, 1_000);
		await readLoop.catch(() => {});
		await stderrLoop.catch(() => {});
	}

	// Re-key diagnostics from file:// URI back to the caller's file paths.
	const byFile = new Map<string, Diagnostic[]>();
	const unreported: string[] = [];
	for (let i = 0; i < opts.files.length; i++) {
		const diags = byUri.get(uris[i]);
		if (diags === undefined) {
			unreported.push(opts.files[i]);
		} else {
			byFile.set(opts.files[i], diags);
		}
	}

	return { byFile, unreported, timedOut };
}

/** Diagnostics at or above Error severity (severity 1, or unset → treated as error). */
export function errorsOf(diags: Diagnostic[]): Diagnostic[] {
	return diags.filter((d) => (d.severity ?? 1) === 1);
}

/**
 * Test-only surface: the pure wire-framing helpers, exposed so the
 * protocol-correctness invariants (exact UTF-8 byte length, `\r\n\r\n`
 * framing) can be unit-tested without spawning ZLS. Not part of the public
 * API; do not import from production code.
 */
export const __test = { frame, headerEnd };
