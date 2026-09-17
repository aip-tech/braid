// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	dropAlreadySeenPrefix,
	type LoadOlderState,
	LogController,
	splitIntoLines,
} from "./log-controller.js";

describe("dropAlreadySeenPrefix", () => {
	it("returns every line unchanged when nothing overlaps", () => {
		expect(dropAlreadySeenPrefix(["a", "b"], ["c", "d"])).toEqual(["c", "d"]);
	});

	it("returns every line unchanged when there's nothing existing to compare against", () => {
		expect(dropAlreadySeenPrefix([], ["a", "b"])).toEqual(["a", "b"]);
	});

	it("drops a varied (non-repeating) overlap in full", () => {
		expect(dropAlreadySeenPrefix(["a", "b", "c"], ["b", "c", "d"])).toEqual([
			"d",
		]);
	});

	it("drops the entire replay when it's fully contained in what's already shown", () => {
		expect(dropAlreadySeenPrefix(["a", "b", "c"], ["b", "c"])).toEqual([]);
	});

	it("drops a single matching line even when it repeats the line before it", () => {
		// The minimum unambiguous case: dropping exactly one duplicate is an acceptable, bounded
		// risk (a genuine reconnect replay is usually literally this), unlike dropping a whole run.
		expect(dropAlreadySeenPrefix(["OK"], ["OK", "new"])).toEqual(["new"]);
	});

	it("does not drop a run of identical lines wholesale, favoring a visible duplicate over losing real output", () => {
		// Regression test: a process logging a repeating "OK" line, then a reconnect replay that
		// happens to start with several more "OK"s (which could be a genuine replay of the same
		// bytes, or brand new output that just repeats the same text) followed by real new content.
		// The old greedy-longest-match behavior dropped the first three "OK"s outright, on the
		// unverifiable assumption they were a replay rather than new output.
		const existing = ["boot", "OK", "OK", "OK"];
		const replay = ["OK", "OK", "OK", "OK", "new"];
		expect(dropAlreadySeenPrefix(existing, replay)).toEqual([
			"OK",
			"OK",
			"OK",
			"new",
		]);
	});

	it("still drops a fully-repeating replay down to a single duplicate line, not zero", () => {
		const existing = ["OK", "OK", "OK"];
		const replay = ["OK", "OK", "OK"];
		expect(dropAlreadySeenPrefix(existing, replay)).toEqual(["OK", "OK"]);
	});
});

describe("splitIntoLines", () => {
	it("buffers a chunk with no newline entirely as the new pending line", () => {
		expect(splitIntoLines("", "partial")).toEqual({
			lines: [],
			pendingLine: "partial",
		});
	});

	it("completes the pending line once its newline arrives, in a later chunk", () => {
		expect(splitIntoLines("Buil", "ding... 42%\n")).toEqual({
			lines: ["Building... 42%"],
			pendingLine: "",
		});
	});

	it("splits multiple complete lines out of a single chunk", () => {
		expect(splitIntoLines("", "one\ntwo\nthree\n")).toEqual({
			lines: ["one", "two", "three"],
			pendingLine: "",
		});
	});

	it("carries over a trailing partial line after emitting the complete ones", () => {
		expect(splitIntoLines("", "one\ntwo\nthree-partial")).toEqual({
			lines: ["one", "two"],
			pendingLine: "three-partial",
		});
	});

	it("prepends any existing pending line to the first line of the new chunk", () => {
		expect(splitIntoLines("pre", "fix\nsecond\n")).toEqual({
			lines: ["prefix", "second"],
			pendingLine: "",
		});
	});

	it("treats a lone newline as one completed empty line", () => {
		expect(splitIntoLines("", "\n")).toEqual({ lines: [""], pendingLine: "" });
	});

	it("is a no-op for an empty chunk", () => {
		expect(splitIntoLines("partial", "")).toEqual({
			lines: [],
			pendingLine: "partial",
		});
	});
});

// ---- LogController ----
//
// Exercises the class's real behavior against a mocked fetch (both the JSON /api/logs/history
// route and a hand-rolled streaming body for /api/logs?follow=true) and fake timers (for the
// replay-resolve window and the reconnect retry delay), rather than mocking the class away as
// log-pane.spec.tsx does for testing LogPane's own wiring.

type HistoryResponse = { lines: string[]; cursor: string | null };

function jsonResponse(body: unknown, status = 200): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
		text: async () => JSON.stringify(body),
	} as unknown as Response;
}

function textResponse(text: string, status = 200): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		text: async () => text,
	} as unknown as Response;
}

/** A fake streaming body whose reader resolves one `chunks` entry per read() call, then ends. */
function fakeBody(chunks: string[]) {
	let i = 0;
	return {
		getReader() {
			return {
				async read() {
					if (i < chunks.length) {
						const value = new TextEncoder().encode(chunks[i]);
						i += 1;
						return { done: false, value };
					}
					return { done: true, value: undefined };
				},
			};
		},
	};
}

function streamResponse(chunks: string[]): Response {
	return {
		ok: true,
		status: 200,
		body: fakeBody(chunks),
	} as unknown as Response;
}

/** Like fakeBody, but the reader's read() call past the last chunk hangs forever instead of
 *  signaling done - simulates a still-open connection, so replay buffering can be observed before
 *  the stream "ends" (a real, live process's stream doesn't close after just a few lines). */
function openEndedStreamResponse(chunks: string[]): Response {
	let i = 0;
	return {
		ok: true,
		status: 200,
		body: {
			getReader: () => ({
				async read() {
					if (i < chunks.length) {
						const value = new TextEncoder().encode(chunks[i]);
						i += 1;
						return { done: false, value };
					}
					return new Promise(() => {});
				},
			}),
		},
	} as unknown as Response;
}

type FetchImpl = (url: string) => Response | Promise<Response>;

function nameOf(url: string): string | null {
	return new URL(url, "http://localhost").searchParams.get("name");
}

function defaultRouter(url: string): Response {
	if (url.includes("/api/logs/history")) {
		return jsonResponse({ lines: [], cursor: null } satisfies HistoryResponse);
	}
	if (url.includes("/api/logs")) return streamResponse([]);
	throw new Error(`unexpected fetch: ${url}`);
}

let fetchImpl: FetchImpl;
let logEl: HTMLDivElement;
let logInnerEl: HTMLDivElement;
let statusMessages: Array<string | undefined>;
let loadOlderStates: LoadOlderState[];
let controller: LogController | undefined;

function makeController(): LogController {
	statusMessages = [];
	loadOlderStates = [];
	controller = new LogController(logEl, logInnerEl, {
		onStatusChange: (message) => statusMessages.push(message),
		onLoadOlderStateChange: (state) => loadOlderStates.push(state),
	});
	return controller;
}

async function flush(): Promise<void> {
	await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
	vi.useFakeTimers();
	logEl = document.createElement("div");
	logInnerEl = document.createElement("div");
	logEl.appendChild(logInnerEl);
	document.body.appendChild(logEl);
	// jsdom never lays anything out, so logEl's real offsetWidth/offsetHeight are always 0 -
	// @tanstack/virtual-core reads those synchronously on mount to size its viewport, and a
	// zero-sized viewport makes it report zero virtual items regardless of how many lines exist.
	// Stubbing a real size here is what makes .log-line rows actually render in these tests.
	Object.defineProperty(logEl, "offsetHeight", {
		configurable: true,
		value: 600,
	});
	Object.defineProperty(logEl, "offsetWidth", {
		configurable: true,
		value: 800,
	});
	fetchImpl = defaultRouter;
	vi.stubGlobal(
		"fetch",
		vi.fn((url: string) => Promise.resolve(fetchImpl(url))),
	);
});

afterEach(() => {
	controller?.destroy();
	controller = undefined;
	logEl.remove();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("LogController: start/stop/destroy", () => {
	it("fetches initial history, then opens a live follow stream, for the given name", async () => {
		const urls: string[] = [];
		fetchImpl = (url) => {
			urls.push(url);
			return defaultRouter(url);
		};
		makeController().start("web");
		await flush();

		expect(urls[0]).toContain("/api/logs/history?name=web&lines=300");
		expect(urls[1]).toContain("/api/logs?name=web&follow=true");
	});

	it("is a no-op when called again with the same name while already streaming it", async () => {
		let historyCalls = 0;
		fetchImpl = (url) => {
			if (url.includes("/history")) historyCalls++;
			return defaultRouter(url);
		};
		const c = makeController();
		c.start("web");
		await flush();
		c.start("web");
		await flush();

		expect(historyCalls).toBe(1);
	});

	it("restarts with a fresh history+stream fetch when called with a different name", async () => {
		const historyNames: Array<string | null> = [];
		fetchImpl = (url) => {
			if (url.includes("/history")) historyNames.push(nameOf(url));
			return defaultRouter(url);
		};
		const c = makeController();
		c.start("web");
		await flush();
		c.start("worker");
		await flush();

		expect(historyNames).toEqual(["web", "worker"]);
	});

	it("clears any previous status message on start()", async () => {
		fetchImpl = (url) => {
			if (url.includes("/history"))
				return jsonResponse({ lines: [], cursor: null });
			return textResponse("Unauthorized", 401);
		};
		const c = makeController();
		c.start("web");
		await flush();
		expect(statusMessages.at(-1)).toContain("Session expired");

		fetchImpl = defaultRouter;
		c.start("worker");
		expect(statusMessages.at(-1)).toBeUndefined();
		await flush();
	});

	it("stop() aborts the in-flight fetch and is a no-op when called again or with nothing active", () => {
		const c = makeController();
		expect(() => c.stop()).not.toThrow(); // nothing active yet
		c.start("web");
		expect(() => c.stop()).not.toThrow();
		expect(() => c.stop()).not.toThrow(); // already stopped
	});

	it("destroy() stops any active stream and releases the virtualizer without throwing", async () => {
		const c = makeController();
		c.start("web");
		await flush();
		expect(() => c.destroy()).not.toThrow();
		controller = undefined; // already destroyed - afterEach shouldn't destroy it again
	});
});

describe("LogController: initial history", () => {
	it("prepends history lines and reports load-older availability from the cursor", async () => {
		fetchImpl = (url) => {
			if (url.includes("/history")) {
				return jsonResponse({ lines: ["one", "two"], cursor: "c1" });
			}
			return streamResponse([]);
		};
		makeController().start("web");
		await flush();

		const rows = [...logInnerEl.querySelectorAll(".log-line")].map(
			(row) => row.textContent,
		);
		expect(rows).toEqual(["one", "two"]);
		expect(loadOlderStates.at(-1)).toEqual({ hidden: false, loading: false });
	});

	it("reports load-older as hidden when there's no further cursor", async () => {
		makeController().start("web"); // defaultRouter: cursor null
		await flush();
		expect(loadOlderStates.at(-1)).toEqual({ hidden: true, loading: false });
	});

	it("still opens the live stream when the history fetch resolves non-ok", async () => {
		let followCalled = false;
		fetchImpl = (url) => {
			if (url.includes("/history")) return textResponse("boom", 500);
			followCalled = true;
			return streamResponse([]);
		};
		makeController().start("web");
		await flush();
		expect(followCalled).toBe(true);
		expect(logInnerEl.querySelectorAll(".log-line").length).toBe(0);
	});

	it("still opens the live stream when the history fetch itself throws", async () => {
		let followCalled = false;
		fetchImpl = (url) => {
			if (url.includes("/history")) throw new Error("network down");
			followCalled = true;
			return streamResponse([]);
		};
		makeController().start("web");
		await flush();
		expect(followCalled).toBe(true);
	});

	it("ignores a stale history response for a stream already superseded by a new start()", async () => {
		let resolveFirst: ((res: Response) => void) | undefined;
		let historyCalls = 0;
		fetchImpl = (url) => {
			if (url.includes("/history")) {
				historyCalls++;
				if (historyCalls === 1) {
					return new Promise<Response>((resolve) => {
						resolveFirst = resolve;
					});
				}
				return jsonResponse({ lines: ["second"], cursor: null });
			}
			return streamResponse([]);
		};
		const c = makeController();
		c.start("web");
		c.start("worker");
		await flush();

		resolveFirst?.(jsonResponse({ lines: ["first-stale"], cursor: "c1" }));
		await flush();

		const rows = [...logInnerEl.querySelectorAll(".log-line")].map(
			(row) => row.textContent,
		);
		expect(rows).not.toContain("first-stale");
	});

	it("ignores a stale history response superseded during its own json() parse (after the outer res.ok check already passed)", async () => {
		let resolveFirstJson: ((data: HistoryResponse) => void) | undefined;
		let historyCalls = 0;
		fetchImpl = (url) => {
			if (url.includes("/history")) {
				historyCalls++;
				if (historyCalls === 1) {
					return {
						ok: true,
						status: 200,
						json: () =>
							new Promise<HistoryResponse>((resolve) => {
								resolveFirstJson = resolve;
							}),
					} as unknown as Response;
				}
				// "worker"'s own initial history fetch, once start() supersedes "web" below.
				return jsonResponse({ lines: [], cursor: null });
			}
			return streamResponse([]);
		};
		const c = makeController();
		c.start("web");
		await flush(); // fetch resolves (ok:true), the outer check passes, now awaiting res.json()
		c.start("worker"); // supersedes "web" while its own json() parse is still pending

		resolveFirstJson?.({ lines: ["stale"], cursor: "c1" });
		await flush();

		const rows = [...logInnerEl.querySelectorAll(".log-line")].map(
			(row) => row.textContent,
		);
		expect(rows).not.toContain("stale");
	});
});

describe("LogController: loadOlder", () => {
	it("is a no-op with no active stream", () => {
		const c = makeController();
		expect(() => c.loadOlder()).not.toThrow();
		expect(loadOlderStates).toEqual([]);
	});

	it("is a no-op once there's no further history (cursor is null)", async () => {
		const c = makeController();
		c.start("web"); // defaultRouter: cursor null
		await flush();
		const callsBefore = vi.mocked(fetch).mock.calls.length;

		c.loadOlder();
		await flush();

		expect(vi.mocked(fetch).mock.calls.length).toBe(callsBefore);
	});

	it("is a no-op while a previous loadOlder() page is still loading", async () => {
		let historyCalls = 0;
		fetchImpl = (url) => {
			if (url.includes("/history")) {
				historyCalls++;
				if (historyCalls === 1)
					return jsonResponse({ lines: ["a"], cursor: "c1" });
				return new Promise<Response>(() => {}); // hangs - still "loading"
			}
			return streamResponse([]);
		};
		const c = makeController();
		c.start("web");
		await flush();
		c.loadOlder();
		await flush();
		c.loadOlder();
		await flush();

		expect(historyCalls).toBe(2);
	});

	it("fetches an older page with the current cursor, prepends it, and updates the cursor", async () => {
		let beforeParam: string | null = null;
		let historyCalls = 0;
		fetchImpl = (url) => {
			if (url.includes("/history")) {
				historyCalls++;
				if (historyCalls === 1) {
					return jsonResponse({ lines: ["b"], cursor: "cursor-1" });
				}
				beforeParam = new URL(url, "http://localhost").searchParams.get(
					"before",
				);
				return jsonResponse({ lines: ["a"], cursor: null });
			}
			return streamResponse([]);
		};
		const c = makeController();
		c.start("web");
		await flush();
		c.loadOlder();
		await flush();

		expect(beforeParam).toBe("cursor-1");
		const rows = [...logInnerEl.querySelectorAll(".log-line")].map(
			(row) => row.textContent,
		);
		expect(rows).toEqual(["a", "b"]);
		expect(loadOlderStates.at(-1)).toEqual({ hidden: true, loading: false });
	});

	it("clears the loading state (keeping the cursor) when the older-page fetch resolves non-ok", async () => {
		let historyCalls = 0;
		fetchImpl = (url) => {
			if (url.includes("/history")) {
				historyCalls++;
				if (historyCalls === 1) {
					return jsonResponse({ lines: [], cursor: "cursor-1" });
				}
				return textResponse("boom", 500);
			}
			return streamResponse([]);
		};
		const c = makeController();
		c.start("web");
		await flush();
		c.loadOlder();
		await flush();

		expect(loadOlderStates.at(-1)).toEqual({ hidden: false, loading: false });
		c.loadOlder(); // still has a cursor - can retry
		await flush();
		expect(historyCalls).toBe(3);
	});

	it("clears the loading state when the older-page fetch itself throws", async () => {
		let historyCalls = 0;
		fetchImpl = (url) => {
			if (url.includes("/history")) {
				historyCalls++;
				if (historyCalls === 1) {
					return jsonResponse({ lines: [], cursor: "cursor-1" });
				}
				throw new Error("network down");
			}
			return streamResponse([]);
		};
		const c = makeController();
		c.start("web");
		await flush();
		c.loadOlder();
		await flush();
		expect(loadOlderStates.at(-1)?.loading).toBe(false);
	});

	it("ignores a stale older-page response for a stream that's since been superseded", async () => {
		let resolveOlder: ((res: Response) => void) | undefined;
		let historyCalls = 0;
		fetchImpl = (url) => {
			if (url.includes("/history")) {
				historyCalls++;
				if (historyCalls === 1) {
					return jsonResponse({ lines: [], cursor: "cursor-1" });
				}
				if (historyCalls === 2) {
					return new Promise<Response>((resolve) => {
						resolveOlder = resolve;
					});
				}
				// "worker"'s own initial history fetch, once start() supersedes "web" below.
				return jsonResponse({ lines: [], cursor: null });
			}
			return streamResponse([]);
		};
		const c = makeController();
		c.start("web");
		await flush();
		c.loadOlder();
		await flush();
		c.start("worker");
		await flush();

		resolveOlder?.(jsonResponse({ lines: ["stale"], cursor: null }));
		await flush();

		const rows = [...logInnerEl.querySelectorAll(".log-line")].map(
			(row) => row.textContent,
		);
		expect(rows).not.toContain("stale");
	});

	it("ignores a stale older-page response superseded during its own json() parse (after the outer res.ok check already passed)", async () => {
		let resolveOlderJson: ((data: HistoryResponse) => void) | undefined;
		let historyCalls = 0;
		fetchImpl = (url) => {
			if (url.includes("/history")) {
				historyCalls++;
				if (historyCalls === 1) {
					return jsonResponse({ lines: [], cursor: "cursor-1" });
				}
				if (historyCalls === 2) {
					return {
						ok: true,
						status: 200,
						json: () =>
							new Promise<HistoryResponse>((resolve) => {
								resolveOlderJson = resolve;
							}),
					} as unknown as Response;
				}
				// "worker"'s own initial history fetch, once start() supersedes "web" below.
				return jsonResponse({ lines: [], cursor: null });
			}
			return streamResponse([]);
		};
		const c = makeController();
		c.start("web");
		await flush();
		c.loadOlder();
		await flush(); // the older-page fetch resolves (ok:true), outer check passes, awaiting json()
		c.start("worker"); // supersedes "web" while that json() parse is still pending

		resolveOlderJson?.({ lines: ["stale"], cursor: null });
		await flush();

		const rows = [...logInnerEl.querySelectorAll(".log-line")].map(
			(row) => row.textContent,
		);
		expect(rows).not.toContain("stale");
	});
});

describe("LogController: live follow stream response handling", () => {
	it("shows a session-expired message on 401, without scheduling a retry", async () => {
		let followCalls = 0;
		fetchImpl = (url) => {
			if (url.includes("/history"))
				return jsonResponse({ lines: [], cursor: null });
			followCalls++;
			return textResponse("Unauthorized", 401);
		};
		makeController().start("web");
		await flush();

		expect(statusMessages.at(-1)).toContain("Session expired");
		await vi.advanceTimersByTimeAsync(5000);
		expect(followCalls).toBe(1);
	});

	it("shows an unknown-process message on 404, without scheduling a retry", async () => {
		let followCalls = 0;
		fetchImpl = (url) => {
			if (url.includes("/history"))
				return jsonResponse({ lines: [], cursor: null });
			followCalls++;
			return textResponse("Not found", 404);
		};
		makeController().start("web");
		await flush();

		expect(statusMessages.at(-1)).toBe('Unknown process "web".');
		await vi.advanceTimersByTimeAsync(5000);
		expect(followCalls).toBe(1);
	});

	it("reports the status and body, then retries, for any other non-ok response", async () => {
		let followCalls = 0;
		fetchImpl = (url) => {
			if (url.includes("/history"))
				return jsonResponse({ lines: [], cursor: null });
			followCalls++;
			if (followCalls === 1) return textResponse("Internal error", 500);
			return streamResponse([]);
		};
		makeController().start("web");
		await flush();

		// scheduleLogRetry immediately overwrites the status with "Reconnecting..." in the same
		// tick, so the 500 message is only ever visible as an intermediate entry, not the last one.
		expect(statusMessages).toContain("braid: 500 Internal error");
		expect(statusMessages.at(-1)).toBe("Reconnecting...");
		expect(followCalls).toBe(1);
		await vi.advanceTimersByTimeAsync(2000);
		expect(followCalls).toBe(2);
	});

	it("reports that streaming isn't supported when the response has no body, without retrying", async () => {
		let followCalls = 0;
		fetchImpl = (url) => {
			if (url.includes("/history"))
				return jsonResponse({ lines: [], cursor: null });
			followCalls++;
			return { ok: true, status: 200, body: null } as unknown as Response;
		};
		makeController().start("web");
		await flush();

		expect(statusMessages.at(-1)).toBe(
			"Log streaming isn't supported by this browser.",
		);
		await vi.advanceTimersByTimeAsync(5000);
		expect(followCalls).toBe(1);
	});

	it("schedules a retry when the follow fetch itself throws", async () => {
		let followCalls = 0;
		fetchImpl = (url) => {
			if (url.includes("/history"))
				return jsonResponse({ lines: [], cursor: null });
			followCalls++;
			if (followCalls === 1) throw new TypeError("Failed to fetch");
			return streamResponse([]);
		};
		makeController().start("web");
		await flush();

		expect(statusMessages.at(-1)).toBe("Reconnecting...");
		await vi.advanceTimersByTimeAsync(2000);
		expect(followCalls).toBe(2);
	});

	it("does not schedule a retry when the follow fetch rejects because stop() aborted it", async () => {
		let followCalls = 0;
		let rejectFollow: ((err: unknown) => void) | undefined;
		fetchImpl = (url) => {
			if (url.includes("/history"))
				return jsonResponse({ lines: [], cursor: null });
			followCalls++;
			return new Promise<Response>((_, reject) => {
				rejectFollow = reject;
			});
		};
		const c = makeController();
		c.start("web");
		await flush();
		c.stop();
		rejectFollow?.(new DOMException("The operation was aborted", "AbortError"));
		await flush();

		await vi.advanceTimersByTimeAsync(5000);
		expect(followCalls).toBe(1);
	});

	it("ignores a stale follow response/stream for a connection superseded by a new start()", async () => {
		let resolveFollow: ((res: Response) => void) | undefined;
		let followCalls = 0;
		fetchImpl = (url) => {
			if (url.includes("/history"))
				return jsonResponse({ lines: [], cursor: null });
			followCalls++;
			if (followCalls === 1) {
				return new Promise<Response>((resolve) => {
					resolveFollow = resolve;
				});
			}
			// "worker"'s own follow connection, once start() supersedes "web" below.
			return streamResponse([]);
		};
		const c = makeController();
		c.start("web");
		await flush();
		c.start("worker");
		await flush();

		resolveFollow?.(streamResponse(["stale line\n"]));
		await flush();
		await vi.advanceTimersByTimeAsync(400);

		const rows = [...logInnerEl.querySelectorAll(".log-line")].map(
			(row) => row.textContent,
		);
		expect(rows).not.toContain("stale line");
	});

	it("scheduleLogRetry's own guard prevents a stale retry when superseded while awaiting a non-ok response's body", async () => {
		let followCalls = 0;
		let resolveText: ((text: string) => void) | undefined;
		fetchImpl = (url) => {
			if (url.includes("/history"))
				return jsonResponse({ lines: [], cursor: null });
			followCalls++;
			if (followCalls === 1) {
				return {
					ok: false,
					status: 500,
					text: () =>
						new Promise<string>((resolve) => {
							resolveText = resolve;
						}),
				} as unknown as Response;
			}
			// "worker"'s own follow connection, once start() supersedes "web" below - left open
			// (rather than ending cleanly) so it doesn't cycle its own retries and confound the
			// follow-call count this test is checking.
			return openEndedStreamResponse([]);
		};
		const c = makeController();
		c.start("web");
		await flush(); // fetch resolves non-ok, now awaiting res.text()
		c.start("worker"); // supersedes "web" before its error body resolves

		resolveText?.("Internal error");
		await flush();

		// If scheduleLogRetry's own activeStream check (its only protection here, since nothing
		// re-checks between the fetch resolving and this await) didn't catch this, a stale retry
		// would fire a third follow fetch for the long-gone "web" stream once the delay elapses.
		await vi.advanceTimersByTimeAsync(5000);
		expect(followCalls).toBe(2);
	});

	it("stops processing mid read-loop once superseded by a new start()", async () => {
		let readCalls = 0;
		let resolveSecondRead:
			| ((result: { done: boolean; value?: Uint8Array }) => void)
			| undefined;
		const manualStream: Response = {
			ok: true,
			status: 200,
			body: {
				getReader: () => ({
					async read() {
						readCalls++;
						if (readCalls === 1) {
							return {
								done: false,
								value: new TextEncoder().encode("first chunk\n"),
							};
						}
						return new Promise((resolve) => {
							resolveSecondRead = resolve;
						});
					},
				}),
			},
		} as unknown as Response;
		fetchImpl = (url) => {
			if (url.includes("/history"))
				return jsonResponse({ lines: [], cursor: null });
			return manualStream;
		};
		const c = makeController();
		c.start("web");
		await flush(); // reads "first chunk" (buffered), then blocks on a second read()
		c.start("worker"); // supersedes "web" while that second read() is still pending

		resolveSecondRead?.({
			done: false,
			value: new TextEncoder().encode("stale second chunk\n"),
		});
		await flush();
		await vi.advanceTimersByTimeAsync(400);

		const rows = [...logInnerEl.querySelectorAll(".log-line")].map(
			(row) => row.textContent,
		);
		expect(rows).not.toContain("stale second chunk");
	});
});

describe("LogController: live streaming content", () => {
	it("splits chunks on newlines (even split across chunk boundaries) once the replay window resolves", async () => {
		fetchImpl = (url) => {
			if (url.includes("/history"))
				return jsonResponse({ lines: [], cursor: null });
			return streamResponse(["line one\nline t", "wo\nline three\n"]);
		};
		makeController().start("web");
		await flush();
		await vi.advanceTimersByTimeAsync(400);

		const rows = [...logInnerEl.querySelectorAll(".log-line")].map(
			(row) => row.textContent,
		);
		expect(rows).toEqual(["line one", "line two", "line three"]);
	});

	it("buffers replay lines until the resolve window elapses, deduping against existing history", async () => {
		fetchImpl = (url) => {
			if (url.includes("/history")) {
				return jsonResponse({
					lines: ["existing one", "existing two"],
					cursor: null,
				});
			}
			return openEndedStreamResponse([
				"existing one\nexisting two\nnew line\n",
			]);
		};
		makeController().start("web");
		await flush();

		expect(logInnerEl.querySelectorAll(".log-line").length).toBe(2);

		await vi.advanceTimersByTimeAsync(400);
		const rows = [...logInnerEl.querySelectorAll(".log-line")].map(
			(row) => row.textContent,
		);
		expect(rows).toEqual(["existing one", "existing two", "new line"]);
	});

	it("flushes a trailing partial (no-newline) line once the stream ends", async () => {
		fetchImpl = (url) => {
			if (url.includes("/history"))
				return jsonResponse({ lines: [], cursor: null });
			return streamResponse(["no newline at the end"]);
		};
		makeController().start("web");
		await flush();
		await vi.advanceTimersByTimeAsync(400);

		const rows = [...logInnerEl.querySelectorAll(".log-line")].map(
			(row) => row.textContent,
		);
		expect(rows).toEqual(["no newline at the end"]);
	});

	it("schedules a retry once the stream ends cleanly (the server only ever closes on shutdown/drop)", async () => {
		let followCalls = 0;
		fetchImpl = (url) => {
			if (url.includes("/history"))
				return jsonResponse({ lines: [], cursor: null });
			followCalls++;
			return streamResponse(["one\n"]);
		};
		makeController().start("web");
		await flush();
		await vi.advanceTimersByTimeAsync(400);
		expect(followCalls).toBe(1);

		await vi.advanceTimersByTimeAsync(2000);
		expect(followCalls).toBe(2);
	});

	it("doesn't double-resolve replay when the stream ends cleanly after the replay window already resolved it", async () => {
		let resolveRead:
			| ((result: { done: boolean; value?: Uint8Array }) => void)
			| undefined;
		let readCalls = 0;
		let followCalls = 0;
		fetchImpl = (url) => {
			if (url.includes("/history"))
				return jsonResponse({ lines: [], cursor: null });
			followCalls++;
			return {
				ok: true,
				status: 200,
				body: {
					getReader: () => ({
						async read() {
							readCalls++;
							if (readCalls === 1) {
								return {
									done: false,
									value: new TextEncoder().encode("one\n"),
								};
							}
							return new Promise((resolve) => {
								resolveRead = resolve;
							});
						},
					}),
				},
			} as unknown as Response;
		};
		makeController().start("web");
		await flush(); // reads "one" (buffered), then blocks on the next read()
		await vi.advanceTimersByTimeAsync(400); // replay window resolves, pushing "one" as a live line

		resolveRead?.({ done: true, value: undefined }); // the connection now ends cleanly
		await flush();

		const rows = [...logInnerEl.querySelectorAll(".log-line")].map(
			(row) => row.textContent,
		);
		expect(rows).toEqual(["one"]); // not duplicated by a second resolveReplay() pass
		expect(followCalls).toBe(1);
		await vi.advanceTimersByTimeAsync(2000);
		expect(followCalls).toBe(2); // still retries on a clean end, same as before
	});

	it("flushes a partial line left over from a dropped connection once reconnected", async () => {
		let followCalls = 0;
		fetchImpl = (url) => {
			if (url.includes("/history"))
				return jsonResponse({ lines: [], cursor: null });
			followCalls++;
			if (followCalls === 1) {
				let reads = 0;
				return {
					ok: true,
					status: 200,
					body: {
						getReader: () => ({
							async read() {
								reads++;
								if (reads === 1) {
									return {
										done: false,
										value: new TextEncoder().encode("partial-no-newline"),
									};
								}
								throw new Error("connection reset");
							},
						}),
					},
				} as unknown as Response;
			}
			return streamResponse([]);
		};
		makeController().start("web");
		await flush();
		await vi.advanceTimersByTimeAsync(400); // resolve replay on the first (now-dropped) connection
		await vi.advanceTimersByTimeAsync(2000); // triggers the retry -> second, clean connection

		const rows = [...logInnerEl.querySelectorAll(".log-line")].map(
			(row) => row.textContent,
		);
		expect(rows).toContain("partial-no-newline");
	});
});

// ROW_ESTIMATE_PX from log-controller.ts - the virtualizer's per-line height estimate. Not
// exported, but its product with the trimmed line count is the only externally-observable proxy
// for `this.lines.length` in these tests, since jsdom's virtualizer only ever renders the
// *visible* rows (see the offsetHeight/offsetWidth stubbing note in beforeEach above), not every
// line - the total scrollable height is the one signal that still reflects the full line count.
const ROW_ESTIMATE_PX = 18;
// SOFT_MAX_LOG_LINES / HARD_MAX_LOG_LINES from log-controller.ts - not exported, mirrored here.
const SOFT_MAX_LOG_LINES = 5000;
const HARD_MAX_LOG_LINES = 20_000;

describe("LogController: trimming", () => {
	let originalOffsetHeight: PropertyDescriptor | undefined;

	beforeEach(() => {
		// jsdom reports 0 for every element's real offsetHeight (no actual layout) - the virtualizer
		// treats that as an authoritative *measured* row height once a row is actually rendered (see
		// measureElement's fallback in log-controller.ts's renderVisibleRows), overriding the initial
		// ROW_ESTIMATE_PX estimate down to 0. With the hundreds/thousands of pushes these two tests
		// drive, every line eventually scrolls through the rendered (visible + overscan) window and
		// gets "measured" this way, progressively zeroing out the reported total size regardless of
		// how many lines actually exist. Stubbing a real per-row height here (matching
		// ROW_ESTIMATE_PX) is what keeps the height-based line-count assertions below meaningful,
		// matching what a real browser would actually measure a rendered row at.
		originalOffsetHeight = Object.getOwnPropertyDescriptor(
			HTMLElement.prototype,
			"offsetHeight",
		);
		Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
			configurable: true,
			get: () => ROW_ESTIMATE_PX,
		});
	});

	afterEach(() => {
		if (originalOffsetHeight) {
			Object.defineProperty(
				HTMLElement.prototype,
				"offsetHeight",
				originalOffsetHeight,
			);
		}
	});

	it("trims to SOFT_MAX_LOG_LINES once live lines exceed it while anchored at the end (the default, live-tailing state)", async () => {
		// As with the hard-cap test below, preload just under the cap in one history batch (cheap -
		// prependHistoryLines never trims) and only push a handful of live lines to cross it, rather
		// than pushing thousands of individual live lines from zero: each live push re-triggers the
		// virtualizer's full measurement pass over every line, so the latter is needlessly slow.
		const preload = SOFT_MAX_LOG_LINES - 5;
		const extra = 10;
		const bigChunk = `${Array.from({ length: extra }, (_, i) => `live-${i}`).join("\n")}\n`;
		fetchImpl = (url) => {
			if (url.includes("/history")) {
				return jsonResponse({
					lines: Array.from({ length: preload }, (_, i) => `history-${i}`),
					cursor: null,
				});
			}
			return openEndedStreamResponse([bigChunk]);
		};
		makeController().start("web");
		await flush();
		await vi.advanceTimersByTimeAsync(400); // resolve replay, pushing all `extra` lines

		expect(logInnerEl.style.height).toBe(
			`${SOFT_MAX_LOG_LINES * ROW_ESTIMATE_PX}px`,
		);
	});

	it("only trims to HARD_MAX_LOG_LINES while the view is scrolled away from the end", async () => {
		// A manually-driven reader (rather than openEndedStreamResponse's fixed chunk list) lets
		// this test hold the SAME connection open across the scroll-position change below - start()
		// resets `lines` on every call, so the scroll-away state and the flood of live lines that
		// should respect it both need to happen on one single stream.
		let resolveRead:
			| ((result: { done: boolean; value?: Uint8Array }) => void)
			| undefined;
		const manualStream: Response = {
			ok: true,
			status: 200,
			body: {
				getReader: () => ({
					read: () =>
						new Promise((resolve) => {
							resolveRead = resolve;
						}),
				}),
			},
		} as unknown as Response;

		// Just under the hard cap, loaded in one batch (prependHistoryLines doesn't trim, so this
		// alone is cheap regardless of size) - only a handful of live pushes are then needed to
		// cross the cap. Each live push re-triggers the virtualizer's full measurement pass over
		// every line, so pushing thousands of individual lines against an already-huge backlog (as
		// an earlier version of this test did) made it pathologically slow; a handful is enough to
		// prove the trim fires.
		const preload = HARD_MAX_LOG_LINES - 5;
		fetchImpl = (url) => {
			if (url.includes("/history")) {
				return jsonResponse({
					lines: Array.from({ length: preload }, (_, i) => `history-${i}`),
					cursor: null,
				});
			}
			return manualStream;
		};
		makeController().start("web");
		await flush(); // history loads, the follow connection opens and blocks on its first read()

		// Simulate the user having scrolled away from the bottom. isAtEnd()'s distance-from-end
		// calculation is driven by the scroll element's real scrollHeight/clientHeight/scrollTop
		// (not the virtualizer's own estimated total size), all of which jsdom otherwise reports as
		// 0 - stubbing them (a large scrollHeight, a real clientHeight, scrollTop left at 0) plus
		// dispatching the "scroll" event the virtualizer listens on to pick up the new scrollTop is
		// what actually makes it compute "not at end".
		Object.defineProperty(logEl, "scrollTop", { configurable: true, value: 0 });
		Object.defineProperty(logEl, "clientHeight", {
			configurable: true,
			value: 600,
		});
		Object.defineProperty(logEl, "scrollHeight", {
			configurable: true,
			value: 1_000_000,
		});
		logEl.dispatchEvent(new Event("scroll"));

		const extra = 10;
		const bigChunk = `${Array.from({ length: extra }, (_, i) => `live-${i}`).join("\n")}\n`;
		resolveRead?.({ done: false, value: new TextEncoder().encode(bigChunk) });
		await vi.advanceTimersByTimeAsync(400); // resolve replay, pushing all `extra` lines

		expect(logInnerEl.style.height).toBe(
			`${HARD_MAX_LOG_LINES * ROW_ESTIMATE_PX}px`,
		);
	});
});
