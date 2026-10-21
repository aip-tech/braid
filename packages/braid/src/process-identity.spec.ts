import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
	currentStartId,
	defaultIo,
	type IdentityIo,
	isSameProcess,
	liveRecordedPids,
	parseProcStatStartTime,
	parsePsStartTimes,
	processStartTimes,
	START_TIME_TOLERANCE_MS,
} from "./process-identity.js";

// A /proc/<pid>/stat line whose command name contains spaces and parentheses, which is why fields
// have to be counted from the last ")". Field 22 (starttime) is 123456.
const STAT = `4242 (my (weird) app) S 1 4242 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 123456 1000 50 18446744073709551615`;

function fakeIo(overrides: Partial<IdentityIo> = {}): IdentityIo {
	return {
		platform: "darwin",
		readFile: vi.fn(() => {
			throw new Error("ENOENT");
		}),
		ps: vi.fn(() => ""),
		isAlive: vi.fn(() => true),
		...overrides,
	};
}

describe("parseProcStatStartTime", () => {
	it("reads field 22, counting from after the command name's last parenthesis", () => {
		expect(parseProcStatStartTime(STAT)).toBe("123456");
	});

	it("returns undefined for a truncated or malformed line", () => {
		expect(parseProcStatStartTime("4242 (app) S 1 2 3")).toBeUndefined();
		expect(
			parseProcStatStartTime(STAT.replace("123456", "not-a-number")),
		).toBeUndefined();
	});
});

describe("parsePsStartTimes", () => {
	it("parses sorted, space-padded rows and skips blank or unparseable ones", () => {
		const output = [
			"    1 Fri Jul 24 20:17:58 2026    ",
			"  557 Wed Oct 21 15:26:31 2026    ",
			"",
			"  900 not a date",
			"garbage",
		].join("\n");
		const times = parsePsStartTimes(output);
		expect([...times.keys()]).toEqual([1, 557]);
		expect(times.get(557)).toBe(Date.parse("Wed Oct 21 15:26:31 2026"));
	});
});

describe("currentStartId", () => {
	it("combines the boot id and the process's start ticks on Linux", () => {
		const io = fakeIo({
			platform: "linux",
			readFile: (path) =>
				path === "/proc/sys/kernel/random/boot_id" ? "abc-123\n" : STAT,
		});
		expect(currentStartId(4242, io)).toBe("abc-123:123456");
	});

	it("is undefined off Linux, or when /proc can't be read or parsed", () => {
		expect(currentStartId(4242, fakeIo())).toBeUndefined();
		expect(currentStartId(4242, fakeIo({ platform: "linux" }))).toBeUndefined();
		expect(
			currentStartId(
				4242,
				fakeIo({ platform: "linux", readFile: () => "4242 (app) S" }),
			),
		).toBeUndefined();
		expect(
			currentStartId(4242, fakeIo({ platform: "linux", readFile: () => "" })),
		).toBeUndefined();
	});

	it("works against the real OS for this process (on Linux) or returns undefined", () => {
		const id = currentStartId(process.pid);
		if (process.platform === "linux") expect(id).toMatch(/^.+:\d+$/);
		else expect(id).toBeUndefined();
	});
});

describe("processStartTimes", () => {
	it("makes one batched ps call", () => {
		const ps = vi.fn(
			() => "  10 Wed Oct 21 15:26:31 2026\n  11 Wed Oct 21 15:26:32 2026\n",
		);
		const times = processStartTimes([10, 11], fakeIo({ ps }));
		expect(ps).toHaveBeenCalledTimes(1);
		expect(ps).toHaveBeenCalledWith(["-o", "pid=,lstart=", "-p", "10,11"]);
		expect(times.size).toBe(2);
	});

	it("retries one pid at a time when a whole batch came back empty (macOS rejects it outright)", () => {
		const ps = vi.fn((args: string[]) =>
			args[3] === "10" ? "  10 Wed Oct 21 15:26:31 2026\n" : "",
		);
		const times = processStartTimes([10, 999999999], fakeIo({ ps }));
		expect(ps).toHaveBeenCalledTimes(3);
		expect([...times.keys()]).toEqual([10]);
	});

	it("does nothing for no pids, a single empty answer, or Windows", () => {
		const ps = vi.fn(() => "");
		expect(processStartTimes([], fakeIo({ ps })).size).toBe(0);
		expect(processStartTimes([5], fakeIo({ ps })).size).toBe(0);
		expect(ps).toHaveBeenCalledTimes(1);
		expect(processStartTimes([5], fakeIo({ platform: "win32", ps })).size).toBe(
			0,
		);
		expect(ps).toHaveBeenCalledTimes(1);
	});

	it("reads real start times for live pids, including from a partial non-zero ps exit", () => {
		// A pid well inside macOS's range that isn't running makes procps exit 1 while still
		// printing the live one - both must survive.
		const times = processStartTimes([process.pid, 99_990]);
		if (process.platform === "win32") return;
		expect(times.get(process.pid)).toBeLessThanOrEqual(Date.now());
		expect(times.has(99_990)).toBe(false);
	});
});

describe("liveRecordedPids / isSameProcess", () => {
	const recordedAt = "2026-10-21T15:26:31.000Z";
	const recordedMs = Date.parse(recordedAt);
	const psAt = (ms: number) =>
		vi.fn(() => {
			const d = new Date(ms);
			// The same local-time format ps prints.
			return `  42 ${d.toDateString()} ${d.toTimeString().slice(0, 8)}\n`;
		});

	it("skips dead pids without asking ps", () => {
		const ps = vi.fn(() => "");
		const io = fakeIo({ ps, isAlive: () => false });
		expect(isSameProcess({ pid: 42, startedAt: recordedAt }, io)).toBe(false);
		expect(ps).not.toHaveBeenCalled();
	});

	it("accepts a process that started before (or just after) its record was written", () => {
		expect(
			isSameProcess(
				{ pid: 42, startedAt: recordedAt },
				fakeIo({ ps: psAt(recordedMs - 60_000) }),
			),
		).toBe(true);
		expect(
			isSameProcess(
				{ pid: 42, startedAt: recordedAt },
				fakeIo({ ps: psAt(recordedMs + START_TIME_TOLERANCE_MS - 1000) }),
			),
		).toBe(true);
	});

	it("rejects a pid reused by a process that started after the record was written", () => {
		expect(
			isSameProcess(
				{ pid: 42, startedAt: recordedAt },
				fakeIo({ ps: psAt(recordedMs + 60_000) }),
			),
		).toBe(false);
	});

	it("falls back to plain liveness when the start time can't be determined", () => {
		expect(
			isSameProcess(
				{ pid: 42, startedAt: recordedAt },
				fakeIo({ platform: "win32" }),
			),
		).toBe(true);
	});

	it("compares an exact Linux startId, ignoring wall-clock times entirely", () => {
		const linux = (startTime: string) =>
			fakeIo({
				platform: "linux",
				readFile: (path) =>
					path.endsWith("boot_id")
						? "boot\n"
						: STAT.replace("123456", startTime),
				ps: vi.fn(() => {
					throw new Error("ps must not be needed");
				}),
			});
		// Recorded "in the future" on purpose: the exact id wins over any timestamp comparison.
		const record = {
			pid: 42,
			startedAt: "2099-01-01T00:00:00.000Z",
			startId: "boot:123456",
		};
		expect(isSameProcess(record, linux("123456"))).toBe(true);
		expect(isSameProcess(record, linux("999999"))).toBe(false);
	});

	it("uses the start-time check for a startId record when the exact id can't be read here", () => {
		const record = { pid: 42, startedAt: recordedAt, startId: "boot:123456" };
		expect(isSameProcess(record, fakeIo({ ps: psAt(recordedMs - 1000) }))).toBe(
			true,
		);
	});

	it("checks several records with one ps call", () => {
		const ps = vi.fn(
			() =>
				`  1 ${new Date(recordedMs - 5000).toDateString()} ${new Date(recordedMs - 5000).toTimeString().slice(0, 8)}\n` +
				`  2 ${new Date(recordedMs + 60_000).toDateString()} ${new Date(recordedMs + 60_000).toTimeString().slice(0, 8)}\n`,
		);
		const live = liveRecordedPids(
			[
				{ pid: 1, startedAt: recordedAt },
				{ pid: 2, startedAt: recordedAt },
			],
			fakeIo({ ps }),
		);
		expect([...live]).toEqual([1]);
		expect(ps).toHaveBeenCalledTimes(1);
	});

	it("treats a real, exited pid as not live", () => {
		const exited = spawnSync(process.execPath, ["-e", "0"]).pid;
		expect(
			liveRecordedPids([{ pid: exited, startedAt: new Date().toISOString() }])
				.size,
		).toBe(0);
	});

	it("recognises this very process against the real OS", () => {
		const startedAt = new Date().toISOString();
		expect(isSameProcess({ pid: process.pid, startedAt })).toBe(true);
		expect(
			isSameProcess({
				pid: process.pid,
				startedAt: new Date(Date.now() - 24 * 3600_000).toISOString(),
			}),
		).toBe(process.platform === "win32");
	});
});

describe("defaultIo", () => {
	it("reads real files, so a missing /proc just means no exact identity", () => {
		const io = { ...defaultIo, platform: "linux" as const };
		if (process.platform === "linux") {
			expect(currentStartId(process.pid, io)).toMatch(/:\d+$/);
		} else {
			expect(currentStartId(process.pid, io)).toBeUndefined();
		}
	});

	it("returns ps's partial stdout from a failed run, and nothing when ps can't run at all", () => {
		// Out of range on macOS (whole batch rejected), absent on procps: exit 1 either way.
		expect(typeof defaultIo.ps(["-o", "pid=", "-p", "999999999"])).toBe(
			"string",
		);
		const path = process.env.PATH;
		process.env.PATH = "";
		try {
			expect(defaultIo.ps(["-o", "pid=", "-p", "1"])).toBe("");
		} finally {
			process.env.PATH = path;
		}
	});
});
