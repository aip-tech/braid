// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	authFetch,
	NO_TOKEN_MESSAGE,
	readToken,
	setToken,
	TOKEN_REJECTED_MESSAGE,
	type TokenEnvironment,
	unauthorizedMessage,
} from "./auth.js";

function fakeEnv(
	hash: string,
	stored: Record<string, string> = {},
): TokenEnvironment & { stored: Record<string, string>; replaced: string[] } {
	const replaced: string[] = [];
	return {
		stored,
		replaced,
		location: { hash, host: "127.0.0.1:4000", pathname: "/dash/", search: "" },
		history: {
			replaceState: (_data, _unused, url) => {
				replaced.push(String(url));
			},
		},
		storage: {
			getItem: (key) => stored[key] ?? null,
			setItem: (key, value) => {
				stored[key] = value;
			},
		},
	};
}

describe("readToken", () => {
	beforeEach(() => setToken(undefined));

	it("takes the token out of the fragment, stores it per host, and strips it from the address bar", () => {
		const env = fakeEnv("#token=abc123");
		expect(readToken(env)).toBe("abc123");
		expect(env.stored).toEqual({ "braid-token:127.0.0.1:4000": "abc123" });
		expect(env.replaced).toEqual(["/dash/"]);
	});

	it("leaves the rest of the fragment (e.g. a dashboard route) in place", () => {
		const env = fakeEnv("#token=abc&view=x");
		readToken(env);
		expect(env.replaced).toEqual(["/dash/#view=x"]);
	});

	it("falls back to the token this tab stored earlier, as after a reload", () => {
		const env = fakeEnv("#/process/api", {
			"braid-token:127.0.0.1:4000": "stored",
		});
		expect(readToken(env)).toBe("stored");
		expect(env.replaced).toEqual([]);
	});

	it("has no token when neither the fragment nor storage has one", () => {
		expect(readToken(fakeEnv(""))).toBeUndefined();
		expect(unauthorizedMessage()).toBe(NO_TOKEN_MESSAGE);
	});

	it("still works when storage is unavailable or throws (some private modes)", () => {
		const blocked = fakeEnv("#token=abc");
		blocked.storage = {
			getItem: () => {
				throw new Error("SecurityError");
			},
			setItem: () => {
				throw new Error("QuotaExceededError");
			},
		};
		expect(readToken(blocked)).toBe("abc");
		blocked.location = { ...blocked.location, hash: "" };
		expect(readToken(blocked)).toBeUndefined();

		const none = fakeEnv("#token=xyz");
		none.storage = undefined;
		expect(readToken(none)).toBe("xyz");
		none.location = { ...none.location, hash: "" };
		expect(readToken(none)).toBeUndefined();
	});

	it("reads the real window by default", () => {
		history.replaceState(null, "", "/#token=from-window");
		expect(readToken()).toBe("from-window");
		expect(location.hash).toBe("");
		expect(sessionStorage.getItem(`braid-token:${location.host}`)).toBe(
			"from-window",
		);
	});

	it("copes with a window whose sessionStorage getter throws", () => {
		const spy = vi
			.spyOn(window, "sessionStorage", "get")
			.mockImplementation(() => {
				throw new Error("SecurityError");
			});
		history.replaceState(null, "", "/#token=t");
		expect(readToken()).toBe("t");
		spy.mockRestore();
	});
});

describe("unauthorizedMessage", () => {
	it("says the token was rejected when there was one, and that there's none otherwise", () => {
		setToken("abc");
		expect(unauthorizedMessage()).toBe(TOKEN_REJECTED_MESSAGE);
		setToken(undefined);
		expect(unauthorizedMessage()).toBe(NO_TOKEN_MESSAGE);
	});
});

describe("authFetch", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		setToken(undefined);
	});

	it("adds the bearer header, keeping the caller's own headers and options", async () => {
		const fetchMock = vi.fn(async () => new Response("ok"));
		vi.stubGlobal("fetch", fetchMock);
		setToken("abc");

		await authFetch("/api/status", {
			method: "POST",
			headers: { "x-extra": "1" },
		});

		const [url, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toBe("/api/status");
		expect(init.method).toBe("POST");
		const headers = new Headers(init.headers);
		expect(headers.get("Authorization")).toBe("Bearer abc");
		expect(headers.get("x-extra")).toBe("1");
	});

	it("sends no Authorization header without a token", async () => {
		const fetchMock = vi.fn(async () => new Response("ok"));
		vi.stubGlobal("fetch", fetchMock);
		await authFetch("/api/status");
		const [, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(new Headers(init.headers).has("Authorization")).toBe(false);
	});
});
