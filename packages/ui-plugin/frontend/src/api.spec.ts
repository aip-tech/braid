import { afterEach, describe, expect, it, vi } from "vitest";
import {
	fetchBraidVersion,
	formatCpu,
	formatMemory,
	formatStarted,
	type HistorySample,
	type ProcessStatus,
	postAction,
	updateHistory,
} from "./api.js";

function makeProcess(overrides: Partial<ProcessStatus> = {}): ProcessStatus {
	return {
		name: "api",
		pid: 111,
		alive: true,
		startedAt: new Date(0).toISOString(),
		cpu: 1,
		memory: 1024,
		...overrides,
	};
}

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
			status: 200,
			text: async () => "Stopped: my proc",
		}));
		vi.stubGlobal("fetch", fetchMock);

		const result = await postAction("stop", "my proc");

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/processes/stop?name=my%20proc",
			{ method: "POST" },
		);
		expect(result).toEqual({
			ok: true,
			status: 200,
			message: "Stopped: my proc",
		});
	});

	it("reports failure with the response status and body as the message, not an exception", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: false,
				status: 500,
				text: async () => "internal error",
			})),
		);

		const result = await postAction("restart", "api");

		expect(result).toEqual({
			ok: false,
			status: 500,
			message: "internal error",
		});
	});

	it("passes a 401 status straight through, for the caller to treat as a session-expired case", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: false,
				status: 401,
				text: async () => "Unauthorized",
			})),
		);

		const result = await postAction("stop", "api");

		expect(result.status).toBe(401);
	});
});

describe("updateHistory", () => {
	it("appends a new sample for a process reporting cpu/memory this tick", () => {
		const prev = new Map<string, HistorySample[]>([
			["api", [{ cpu: 1, memory: 100 }]],
		]);
		const next = updateHistory(prev, [
			makeProcess({ name: "api", cpu: 2, memory: 200 }),
		]);
		expect(next.get("api")).toEqual([
			{ cpu: 1, memory: 100 },
			{ cpu: 2, memory: 200 },
		]);
	});

	it("evicts a process name no longer present in the status response at all", () => {
		// Regression test: history used to be built by copying `prev` and only ever adding to it,
		// so a process removed from config (or renamed) stayed in the Map - and its samples - for
		// the rest of the tab's lifetime.
		const prev = new Map<string, HistorySample[]>([
			["removed", [{ cpu: 1, memory: 100 }]],
			["api", [{ cpu: 1, memory: 100 }]],
		]);
		const next = updateHistory(prev, [
			makeProcess({ name: "api", cpu: 2, memory: 200 }),
		]);
		expect(next.has("removed")).toBe(false);
		expect(next.has("api")).toBe(true);
	});

	it("keeps a process's existing history when it's present but unsampled this tick (e.g. stopped)", () => {
		const prev = new Map<string, HistorySample[]>([
			["api", [{ cpu: 1, memory: 100 }]],
		]);
		const next = updateHistory(prev, [
			makeProcess({
				name: "api",
				alive: false,
				cpu: undefined,
				memory: undefined,
			}),
		]);
		expect(next.get("api")).toEqual([{ cpu: 1, memory: 100 }]);
	});

	it("caps a process's history at 30 samples, dropping the oldest first", () => {
		const prev = new Map<string, HistorySample[]>([
			["api", Array.from({ length: 30 }, (_, i) => ({ cpu: i, memory: i }))],
		]);
		const next = updateHistory(prev, [
			makeProcess({ name: "api", cpu: 999, memory: 999 }),
		]);
		const samples = next.get("api");
		expect(samples).toHaveLength(30);
		expect(samples?.[0]).toEqual({ cpu: 1, memory: 1 });
		expect(samples?.at(-1)).toEqual({ cpu: 999, memory: 999 });
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
