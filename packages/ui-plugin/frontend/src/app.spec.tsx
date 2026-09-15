// @vitest-environment jsdom
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessStatus } from "./api.js";
import { App } from "./app.js";

function jsonResponse(body: unknown, status = 200): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
		text: async () => JSON.stringify(body),
	} as Response;
}

function textResponse(text: string, status = 200): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => JSON.parse(text),
		text: async () => text,
	} as Response;
}

/** A 200 whose body can't actually be parsed as JSON - a truncated/malformed response. */
function malformedJsonResponse(): Response {
	return {
		ok: true,
		status: 200,
		json: async (): Promise<unknown> => {
			throw new SyntaxError("Unexpected end of JSON input");
		},
		text: async () => "",
	} as Response;
}

function makeProcess(overrides: Partial<ProcessStatus> = {}): ProcessStatus {
	return {
		name: "api",
		pid: 111,
		alive: true,
		startedAt: new Date(0).toISOString(),
		cpu: 1.2,
		memory: 2 * 1024 * 1024,
		...overrides,
	};
}

/** Flushes the microtask queue a couple of times - enough for a fetch().then() chain plus the
 *  resulting Preact state updates to settle inside a single act(). */
async function flush(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

let container: HTMLDivElement;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	location.hash = "";
});

afterEach(() => {
	act(() => render(null, container));
	container.remove();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("App", () => {
	it("loads status and version on mount, and renders one row per process", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url === "/api/ui/version")
					return jsonResponse({ braidVersion: "9.9.9" });
				if (url === "/api/status") return jsonResponse([makeProcess()]);
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);

		act(() => render(<App />, container));
		await flush();

		expect(container.querySelector(".topnav-version")?.textContent).toBe(
			"v9.9.9",
		);
		const rows = container.querySelectorAll("#processes tbody tr");
		expect(rows).toHaveLength(1);
		expect(rows[0].querySelector("a")?.textContent).toBe("api");
		expect(container.querySelector(".error")?.textContent).toBe("");
	});

	it("shows a session-expired banner on a 401, without touching the process table", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url === "/api/ui/version")
					return jsonResponse({ braidVersion: "1.0.0" });
				return textResponse("Unauthorized", 401);
			}),
		);

		act(() => render(<App />, container));
		await flush();

		expect(container.querySelector(".error")?.textContent).toContain(
			"Session expired",
		);
		expect(container.querySelectorAll("#processes tbody tr")).toHaveLength(0);
	});

	it("shows the raw status/body as a banner for any other non-ok response", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url === "/api/ui/version")
					return jsonResponse({ braidVersion: "1.0.0" });
				return textResponse("internal error", 500);
			}),
		);

		act(() => render(<App />, container));
		await flush();

		expect(container.querySelector(".error")?.textContent).toBe(
			"braid: 500 internal error",
		);
	});

	it("shows a lost-connection banner and doesn't crash when fetch itself throws", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url === "/api/ui/version")
					return jsonResponse({ braidVersion: "1.0.0" });
				throw new TypeError("Failed to fetch");
			}),
		);

		act(() => render(<App />, container));
		await flush();

		expect(container.querySelector(".error")?.textContent).toContain(
			"Lost connection",
		);
	});

	it("skips a poll tick silently (no crash, no banner) on a malformed JSON body, and recovers on the next successful poll", async () => {
		// Regression test for a real bug: /api/status's res.json() wasn't wrapped in try/catch, so a
		// 200 with a truncated/malformed body threw inside the unawaited `void refreshStatus()` call
		// in the polling effect, surfacing as an unhandled promise rejection.
		let statusCall = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url === "/api/ui/version")
					return jsonResponse({ braidVersion: "1.0.0" });
				statusCall++;
				if (statusCall === 1) {
					return malformedJsonResponse();
				}
				return jsonResponse([makeProcess()]);
			}),
		);
		const rejections: unknown[] = [];
		const onUnhandledRejection = (reason: unknown) => rejections.push(reason);
		process.on("unhandledRejection", onUnhandledRejection);

		try {
			vi.useFakeTimers();
			act(() => render(<App />, container));
			await flush();

			expect(rejections).toHaveLength(0);
			expect(container.querySelector(".error")?.textContent).toBe("");
			expect(container.querySelectorAll("#processes tbody tr")).toHaveLength(0);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(2000);
			});
			await flush();

			expect(rejections).toHaveLength(0);
			expect(container.querySelectorAll("#processes tbody tr")).toHaveLength(1);
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
		}
	});

	it("renders the detail view for a #/process/<name> route", async () => {
		location.hash = "#/process/api";
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url === "/api/ui/version")
					return jsonResponse({ braidVersion: "1.0.0" });
				return jsonResponse([makeProcess({ name: "api" })]);
			}),
		);

		act(() => render(<App />, container));
		await flush();

		expect(container.querySelector("#processes")).toBeNull();
		expect(container.textContent).toContain("api");
	});

	it("marks a row's button disabled while an action is in flight, then re-enables it", async () => {
		let resolvePost: (() => void) | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url === "/api/ui/version")
					return jsonResponse({ braidVersion: "1.0.0" });
				if (url === "/api/status")
					return jsonResponse([makeProcess({ alive: true })]);
				if (init?.method === "POST") {
					await new Promise<void>((resolve) => {
						resolvePost = resolve;
					});
					return textResponse("Stopped: api");
				}
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);

		act(() => render(<App />, container));
		await flush();

		const stopButton = container.querySelector<HTMLButtonElement>(".btn-stop");
		expect(stopButton).not.toBeNull();
		expect(stopButton?.disabled).toBe(false);

		act(() => stopButton?.click());
		await flush();
		expect(
			container.querySelector<HTMLButtonElement>(".btn-stop")?.disabled,
		).toBe(true);

		resolvePost?.();
		await flush();
		expect(
			container.querySelector<HTMLButtonElement>(".btn-stop")?.disabled,
		).toBe(false);
	});
});
