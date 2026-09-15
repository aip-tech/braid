import { afterEach, describe, expect, it, vi } from "vitest";
import {
	fetchBraidVersion,
	formatCpu,
	formatMemory,
	formatStarted,
	postAction,
} from "./api.js";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("formatCpu", () => {
	it("formats to one decimal place with a percent sign", () => {
		expect(formatCpu(0)).toBe("0.0%");
		expect(formatCpu(12.34)).toBe("12.3%");
		expect(formatCpu(100)).toBe("100.0%");
	});
});

describe("formatMemory", () => {
	it("converts bytes to whole megabytes", () => {
		expect(formatMemory(0)).toBe("0 MB");
		expect(formatMemory(1024 * 1024)).toBe("1 MB");
		expect(formatMemory(10 * 1024 * 1024)).toBe("10 MB");
	});
});

describe("formatStarted", () => {
	it('returns "-" when startedAt is absent', () => {
		expect(formatStarted(undefined)).toBe("-");
	});

	it("formats a valid ISO timestamp using the local date/time format", () => {
		const iso = "2026-01-15T10:30:00.000Z";
		expect(formatStarted(iso)).toBe(new Date(iso).toLocaleString());
	});

	it("returns the raw string unchanged when it isn't a valid date", () => {
		expect(formatStarted("not-a-date")).toBe("not-a-date");
	});
});

describe("postAction", () => {
	it("POSTs to the action route with the name URL-encoded, and reports success", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			text: async () => "Stopped: my proc",
		}));
		vi.stubGlobal("fetch", fetchMock);

		const result = await postAction("stop", "my proc");

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/processes/stop?name=my%20proc",
			{ method: "POST" },
		);
		expect(result).toEqual({ ok: true, message: "Stopped: my proc" });
	});

	it("reports failure with the response body as the message, not an exception", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: false,
				text: async () => "Unauthorized",
			})),
		);

		const result = await postAction("restart", "api");

		expect(result).toEqual({ ok: false, message: "Unauthorized" });
	});
});

describe("fetchBraidVersion", () => {
	it("returns the braidVersion from a successful response", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				json: async () => ({ braidVersion: "1.2.3" }),
			})),
		);

		expect(await fetchBraidVersion()).toBe("1.2.3");
	});

	it("returns undefined on a non-ok response instead of throwing", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: false,
				json: async () => ({ braidVersion: "unused" }),
			})),
		);

		expect(await fetchBraidVersion()).toBeUndefined();
	});

	it("returns undefined instead of throwing when fetch itself rejects", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("network down");
			}),
		);

		expect(await fetchBraidVersion()).toBeUndefined();
	});
});
