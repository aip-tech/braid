import { describe, expect, it, vi } from "vitest";
import {
	createTreeSampler,
	defaultStatsIo,
	parseFootprints,
	parseProcStat,
	parsePsCpuTime,
	parsePsRows,
	readProcessTable,
	type StatsIo,
	treeOf,
} from "./process-stats.js";

function fakeIo(overrides: Partial<StatsIo> = {}): StatsIo {
	return {
		platform: "darwin",
		ps: vi.fn(async () => ""),
		readFile: vi.fn(async () => {
			throw new Error("ENOENT");
		}),
		readDir: vi.fn(async () => []),
		getconf: vi.fn(() => undefined),
		footprint: vi.fn(async () => ""),
		...overrides,
	};
}

describe("parsePsCpuTime", () => {
	it("parses every form ps prints cumulative CPU time in", () => {
		expect(parsePsCpuTime("0:01.46")).toBe(1460);
		expect(parsePsCpuTime("366:39.53")).toBe(366 * 60_000 + 39_530);
		expect(parsePsCpuTime("01:02:03")).toBe(3_723_000);
		expect(parsePsCpuTime("2-01:00:00")).toBe((2 * 24 + 1) * 3_600_000);
		expect(parsePsCpuTime(" 0:00.00 ")).toBe(0);
	});

	it("rejects anything else", () => {
		expect(parsePsCpuTime("")).toBeUndefined();
		expect(parsePsCpuTime("abc")).toBeUndefined();
		expect(parsePsCpuTime("1.5")).toBeUndefined();
	});
});

describe("parsePsRows", () => {
	it("parses padded rows, converting KiB to bytes, and skips malformed ones", () => {
		const output = [
			"    1     0   7760 366:39.53",
			"  557     1  14336   0:01.00",
			"",
			"  bad     1  14336   0:01.00",
			"  600     1  14336   not-a-time",
			"  601     1",
		].join("\n");
		expect(parsePsRows(output)).toEqual([
			{ pid: 1, ppid: 0, rssBytes: 7760 * 1024, cpuMs: 366 * 60_000 + 39_530 },
			{ pid: 557, ppid: 1, rssBytes: 14336 * 1024, cpuMs: 1000 },
		]);
	});
});

describe("parseProcStat", () => {
	// Fields after the name: state ppid pgrp session tty tpgid flags minflt cminflt majflt
	// cmajflt utime stime cutime cstime priority nice threads itrealvalue starttime vsize rss
	const stat = (
		pid: number,
		name: string,
		ppid: number,
		utime: number,
		stime: number,
		rss: number,
	) =>
		`${pid} (${name}) S ${ppid} 1 1 0 -1 0 0 0 0 0 ${utime} ${stime} 0 0 20 0 1 0 999 1000 ${rss} 0`;

	it("reads ppid, CPU ticks and resident pages, even with spaces and parentheses in the name", () => {
		expect(
			parseProcStat(stat(42, "my (odd) app", 7, 150, 50, 1000), 100, 4096),
		).toEqual({
			pid: 42,
			ppid: 7,
			cpuMs: 2000,
			rssBytes: 1000 * 4096,
		});
	});

	it("rejects a malformed line", () => {
		expect(parseProcStat("garbage", 100, 4096)).toBeUndefined();
		expect(parseProcStat("42 (app) S", 100, 4096)).toBeUndefined();
	});
});

describe("parseFootprints", () => {
	it("reads each process's footprint, in any unit, ignoring the rest of the report", () => {
		const output = [
			"======================================================================",
			"node [55622]: 64-bit    Footprint: 63 MB (16384 bytes per page)",
			"  51 MB        0 B          0 B          3    MALLOC_MEDIUM",
			"node [55620]: 64-bit    Footprint: 980 KB (16384 bytes per page)",
			"esbuild [7]: 64-bit    Footprint: 1.5 GB (16384 bytes per page)",
			"Shared with node [55620]:",
			"Summary Footprint: 75 MB",
		].join("\n");
		expect([...parseFootprints(output)]).toEqual([
			[55622, 63 * 1024 ** 2],
			[55620, 980 * 1024],
			[7, Math.round(1.5 * 1024 ** 3)],
		]);
	});
});

describe("treeOf", () => {
	const rows = [
		{ pid: 1, ppid: 0, rssBytes: 1, cpuMs: 1 },
		{ pid: 10, ppid: 1, rssBytes: 10, cpuMs: 10 },
		{ pid: 11, ppid: 10, rssBytes: 100, cpuMs: 100 },
		{ pid: 12, ppid: 10, rssBytes: 1000, cpuMs: 1000 },
		{ pid: 20, ppid: 1, rssBytes: 10_000, cpuMs: 10_000 },
	];

	it("collects the root and all its descendants, and nothing else", () => {
		expect(
			treeOf(rows, 10)
				?.map((row) => row.pid)
				.sort(),
		).toEqual([10, 11, 12]);
	});

	it("is undefined when the root isn't there", () => {
		expect(treeOf(rows, 99)).toBeUndefined();
	});

	it("survives a cycle in a racy snapshot", () => {
		const cyclic = [
			{ pid: 5, ppid: 6, rssBytes: 1, cpuMs: 1 },
			{ pid: 6, ppid: 5, rssBytes: 1, cpuMs: 1 },
		];
		expect(
			treeOf(cyclic, 5)
				?.map((row) => row.pid)
				.sort(),
		).toEqual([5, 6]);
	});
});

describe("readProcessTable", () => {
	it("uses one ps call off Linux, and nothing at all on Windows", async () => {
		const ps = vi.fn(async () => "  5  1  100  0:00.50\n");
		expect(await readProcessTable(fakeIo({ ps }))).toEqual([
			{ pid: 5, ppid: 1, rssBytes: 100 * 1024, cpuMs: 500 },
		]);
		expect(ps).toHaveBeenCalledWith(["-A", "-o", "pid=,ppid=,rss=,time="]);
		expect(await readProcessTable(fakeIo({ platform: "win32", ps }))).toEqual(
			[],
		);
		expect(ps).toHaveBeenCalledTimes(1);
	});

	it("reads /proc on Linux, skipping non-pid entries and processes that exit mid-read", async () => {
		const io = fakeIo({
			platform: "linux",
			readDir: async () => ["1", "self", "2", "3"],
			readFile: async (path) => {
				if (path === "/proc/2/stat") throw new Error("ENOENT"); // gone already
				if (path === "/proc/3/stat") return "garbage";
				return "1 (init) S 0 1 1 0 -1 0 0 0 0 0 200 100 0 0 20 0 1 0 1 1000 50 0";
			},
			getconf: (name) => (name === "CLK_TCK" ? 100 : 4096),
		});
		expect(await readProcessTable(io)).toEqual([
			{ pid: 1, ppid: 0, cpuMs: 3000, rssBytes: 50 * 4096 },
		]);
	});

	it("falls back to standard tick and page sizes when getconf can't answer", async () => {
		const io = fakeIo({
			platform: "linux",
			readDir: async () => ["1"],
			readFile: async () =>
				"1 (init) S 0 1 1 0 -1 0 0 0 0 0 100 0 0 0 20 0 1 0 1 1000 2 0",
		});
		expect(await readProcessTable(io)).toEqual([
			{ pid: 1, ppid: 0, cpuMs: 1000, rssBytes: 2 * 4096 },
		]);
	});
});

describe("createTreeSampler", () => {
	/** A fake process table whose CPU times can be advanced between samples. */
	function psWith(rows: Array<[number, number, number, string]>) {
		return vi.fn(async () =>
			rows
				.map(([pid, ppid, rssKib, time]) => `${pid} ${ppid} ${rssKib} ${time}`)
				.join("\n"),
		);
	}

	it("gives memory at once and CPU % from the second sample, summed over each tree", async () => {
		let rows: Array<[number, number, number, string]> = [
			[10, 1, 1000, "0:01.00"],
			[11, 10, 3000, "0:02.00"],
			[20, 1, 500, "0:00.00"],
		];
		const ps = vi.fn(async () => psWith(rows)());
		const sample = createTreeSampler(fakeIo({ platform: "freebsd", ps }));
		let clock = 0;
		const now = () => clock;

		const first = await sample([10, 20], now);
		expect(first.get(10)).toEqual({ memory: 4000 * 1024 });
		expect(first.get(20)).toEqual({ memory: 500 * 1024 });

		// One second later: tree 10 used 1.5s of CPU (150% - more than one core), tree 20 0.25s.
		clock = 1000;
		rows = [
			[10, 1, 1000, "0:01.50"],
			[11, 10, 3000, "0:03.00"],
			[20, 1, 500, "0:00.25"],
		];
		const second = await sample([10, 20], now);
		expect(second.get(10)).toEqual({ memory: 4000 * 1024, cpu: 150 });
		expect(second.get(20)).toEqual({ memory: 500 * 1024, cpu: 25 });
	});

	it("reads an idle interval, not a negative one, when a CPU-heavy child has exited", async () => {
		let rows: Array<[number, number, number, string]> = [
			[10, 1, 1000, "0:01.00"],
			[11, 10, 1000, "0:05.00"],
		];
		const sample = createTreeSampler(
			fakeIo({ platform: "freebsd", ps: vi.fn(async () => psWith(rows)()) }),
		);
		let clock = 0;
		await sample([10], () => clock);
		clock = 1000;
		rows = [[10, 1, 1000, "0:01.10"]];
		expect((await sample([10], () => clock)).get(10)?.cpu).toBe(0);
	});

	it("forgets a root that disappears or stops being asked for, so it starts over", async () => {
		const rows: Array<[number, number, number, string]> = [
			[10, 1, 1000, "0:01.00"],
		];
		const sample = createTreeSampler(
			fakeIo({ platform: "freebsd", ps: vi.fn(async () => psWith(rows)()) }),
		);
		let clock = 0;
		await sample([10], () => clock);
		clock = 1000;
		expect((await sample([], () => clock)).size).toBe(0);
		clock = 2000;
		// Back again: a first sample once more, so no CPU yet.
		expect((await sample([10], () => clock)).get(10)).toEqual({
			memory: 1000 * 1024,
		});
		expect((await sample([10, 99], () => clock)).has(99)).toBe(false);
		// Same instant as the previous sample: no interval to measure CPU over.
		expect((await sample([10], () => clock)).get(10)?.cpu).toBeUndefined();
	});

	it("uses macOS footprints for memory where available, and RSS for any process footprint missed", async () => {
		const footprint = vi.fn(
			async () =>
				"node [10]: 64-bit    Footprint: 200 MB (16384 bytes per page)",
		);
		const sample = createTreeSampler(
			fakeIo({
				platform: "darwin",
				ps: psWith([
					[10, 1, 1000, "0:01.00"],
					[11, 10, 2000, "0:01.00"],
				]),
				footprint,
			}),
		);
		const stats = await sample([10]);
		expect(footprint).toHaveBeenCalledWith([10, 11]);
		expect(stats.get(10)?.memory).toBe(200 * 1024 ** 2 + 2000 * 1024);
	});

	it("doesn't run footprint when there's nothing to measure", async () => {
		const footprint = vi.fn(async () => "");
		const sample = createTreeSampler(fakeIo({ platform: "darwin", footprint }));
		expect((await sample([10])).size).toBe(0);
		expect(footprint).not.toHaveBeenCalled();
	});
});

describe("defaultStatsIo", () => {
	it.skipIf(process.platform === "win32")(
		"reads the real process table by default",
		async () => {
			const rows = await readProcessTable();
			expect(rows.some((row) => row.pid === process.pid)).toBe(true);
		},
	);

	it.skipIf(process.platform === "win32")(
		"measures this very process for real",
		async () => {
			const stats = (await createTreeSampler()([process.pid])).get(process.pid);
			expect(stats?.memory).toBeGreaterThan(10 * 1024 * 1024);
		},
	);

	it("reads files and directories, and runs getconf", async () => {
		expect(await defaultStatsIo.readDir(".")).toContain("package.json");
		expect(await defaultStatsIo.readFile("package.json")).toContain('"name"');
		expect(defaultStatsIo.getconf("PAGESIZE")).toBeGreaterThan(0);
		expect(defaultStatsIo.getconf("NOT_A_REAL_GETCONF_NAME")).toBeUndefined();
		// A real name whose value isn't a number (a search path).
		expect(defaultStatsIo.getconf("PATH")).toBeUndefined();
	});

	it("resolves ps's output when it succeeds, rejects when it fails, and resolves footprint to empty output when it can't run", async () => {
		// Called directly on every platform: on Linux the sampler itself reads /proc instead, so
		// nothing else would ever run a successful ps there.
		expect(
			await defaultStatsIo.ps(["-o", "pid=", "-p", String(process.pid)]),
		).toContain(String(process.pid));
		await expect(
			defaultStatsIo.ps(["--definitely-not-a-flag"]),
		).rejects.toThrow();
		const path = process.env.PATH;
		process.env.PATH = "";
		try {
			expect(await defaultStatsIo.footprint([process.pid])).toBe("");
		} finally {
			process.env.PATH = path;
		}
	});
});
