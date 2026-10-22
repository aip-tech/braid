import { execFile, execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";

/**
 * CPU and memory for each supervised app, summed over its whole process tree - the app and
 * everything it spawned (a `pnpm dev` wrapper's real server, a bundler's worker processes), but
 * not braid's own wrapper above it. Read straight from the OS, one snapshot of every process per
 * poll: `/proc` on Linux, a single `ps` on macOS and other POSIX systems. Windows gets no stats.
 *
 * CPU % is the tree's CPU time used since the previous poll, divided by the wall time between
 * them (100 = one core's worth) - so it needs two polls before it's known.
 *
 * Memory is summed per process over the tree. On macOS that's each process's physical footprint
 * (what Activity Monitor shows), from one `footprint` call: macOS's RSS leaves out memory it has
 * compressed or swapped, so on a busy Mac it can under-report an app several times over. If
 * `footprint` can't run, or misses a process, its RSS is used instead. Linux uses RSS.
 */

export type ProcessRow = {
	pid: number;
	ppid: number;
	rssBytes: number;
	/** Cumulative CPU time (user + system) since the process started. */
	cpuMs: number;
};

export type TreeStats = {
	memory: number;
	/** Absent on a tree's first sample - there's no previous one to measure from yet. */
	cpu?: number;
};

/** What the sampler reads from the OS - injectable, so every platform's path is testable anywhere. */
export type StatsIo = {
	platform: NodeJS.Platform;
	/** Runs `ps` with `args`, resolving its stdout. */
	ps(args: string[]): Promise<string>;
	readFile(path: string): Promise<string>;
	readDir(path: string): Promise<string[]>;
	/** `getconf <name>` as a number, or undefined if it can't be read. */
	getconf(name: string): number | undefined;
	/** macOS `footprint -p <pid>...`, resolving its stdout ("" if it can't run). */
	footprint(pids: number[]): Promise<string>;
};

export const defaultStatsIo: StatsIo = {
	platform: process.platform,
	ps: (args) =>
		new Promise((resolve, reject) => {
			execFile(
				"ps",
				args,
				{ encoding: "utf8", env: { ...process.env, LC_ALL: "C" } },
				(error, stdout) => (error ? reject(error) : resolve(stdout)),
			);
		}),
	readFile: (path) => readFile(path, "utf8"),
	readDir: (path) => readdir(path),
	footprint: (pids) =>
		new Promise((resolve) => {
			execFile(
				"footprint",
				pids.flatMap((pid) => ["-p", String(pid)]),
				{ encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
				// Missing pids only produce stderr noise, and a failed run leaves stdout empty: either
				// way, whatever parses is what's used.
				(_error, stdout) => resolve(stdout),
			);
		}),
	getconf(name) {
		try {
			const value = Number(
				execFileSync("getconf", [name], { encoding: "utf8" }),
			);
			// NaN (unparseable output) isn't > 0 either.
			return value > 0 ? value : undefined;
		} catch {
			return undefined;
		}
	},
};

/** `ps`'s cumulative `time` column - `[[dd-]hh:]mm:ss[.cc]` - in milliseconds. */
export function parsePsCpuTime(value: string): number | undefined {
	const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(
		value.trim(),
	);
	if (!match) return undefined;
	const [, days = "0", hours = "0", minutes, seconds] = match;
	return Math.round(
		((Number(days) * 24 + Number(hours)) * 3600 +
			Number(minutes) * 60 +
			Number(seconds)) *
			1000,
	);
}

const FOOTPRINT_UNITS: Record<string, number> = {
	B: 1,
	KB: 1024,
	MB: 1024 ** 2,
	GB: 1024 ** 3,
	TB: 1024 ** 4,
};

/** Per-pid physical footprints (bytes) from `footprint` output's "name [pid]: ... Footprint:
 *  12 MB" lines; everything else in its output (the per-category breakdown) is ignored. */
export function parseFootprints(output: string): Map<number, number> {
	const footprints = new Map<number, number>();
	const line = /\[(\d+)\]:.*?\bFootprint:\s+([\d.]+)\s+(B|KB|MB|GB|TB)\b/g;
	for (const match of output.matchAll(line)) {
		const [, pid, amount, unit] = match as unknown as [
			string,
			string,
			string,
			string,
		];
		footprints.set(
			Number(pid),
			Math.round(Number(amount) * (FOOTPRINT_UNITS[unit] as number)),
		);
	}
	return footprints;
}

/** Rows of `ps -A -o pid=,ppid=,rss=,time=` (rss in KiB). Unparseable lines are skipped. */
export function parsePsRows(output: string): ProcessRow[] {
	const rows: ProcessRow[] = [];
	for (const line of output.split("\n")) {
		const fields = line.trim().split(/\s+/);
		if (fields.length !== 4) continue;
		const [pid, ppid, rssKib, time] = fields as [
			string,
			string,
			string,
			string,
		];
		const cpuMs = parsePsCpuTime(time);
		if (!/^\d+$/.test(pid) || !/^\d+$/.test(ppid) || !/^\d+$/.test(rssKib)) {
			continue;
		}
		if (cpuMs === undefined) continue;
		rows.push({
			pid: Number(pid),
			ppid: Number(ppid),
			rssBytes: Number(rssKib) * 1024,
			cpuMs,
		});
	}
	return rows;
}

/**
 * One `/proc/<pid>/stat` line as a row. The command name (field 2) is parenthesised and may contain
 * spaces or parentheses itself, so fields are counted from after its last `)`: field 4 is ppid,
 * 14 and 15 are user and system time in clock ticks, 24 is the resident set in pages.
 */
export function parseProcStat(
	stat: string,
	ticksPerSecond: number,
	pageSize: number,
): ProcessRow | undefined {
	const open = stat.indexOf(" (");
	const close = stat.lastIndexOf(")");
	if (open === -1 || close === -1) return undefined;
	const pid = Number(stat.slice(0, open));
	// After the name: [0] is field 3 (state), so field N is at index N - 3.
	const fields = stat
		.slice(close + 1)
		.trim()
		.split(/\s+/);
	const ppid = Number(fields[1]);
	const ticks = Number(fields[11]) + Number(fields[12]);
	const pages = Number(fields[21]);
	if (![pid, ppid, ticks, pages].every(Number.isFinite)) return undefined;
	return {
		pid,
		ppid,
		rssBytes: pages * pageSize,
		cpuMs: Math.round((ticks / ticksPerSecond) * 1000),
	};
}

/** A snapshot of every process on the machine, or [] where there's no way to take one. */
export async function readProcessTable(
	io: StatsIo = defaultStatsIo,
	linuxUnits = linuxUnitsFor(io),
): Promise<ProcessRow[]> {
	if (io.platform === "win32") return [];
	if (io.platform !== "linux") {
		return parsePsRows(await io.ps(["-A", "-o", "pid=,ppid=,rss=,time="]));
	}
	const { ticksPerSecond, pageSize } = linuxUnits();
	const pids = (await io.readDir("/proc")).filter((entry) =>
		/^\d+$/.test(entry),
	);
	const rows = await Promise.all(
		pids.map(async (pid) => {
			try {
				return parseProcStat(
					await io.readFile(`/proc/${pid}/stat`),
					ticksPerSecond,
					pageSize,
				);
			} catch {
				return undefined; // exited between the directory listing and the read
			}
		}),
	);
	return rows.filter((row): row is ProcessRow => row !== undefined);
}

/** Linux's clock tick rate and page size, looked up once (they can't change while running). */
function linuxUnitsFor(
	io: StatsIo,
): () => { ticksPerSecond: number; pageSize: number } {
	let units: { ticksPerSecond: number; pageSize: number } | undefined;
	return () => {
		units ??= {
			ticksPerSecond: io.getconf("CLK_TCK") ?? 100,
			pageSize: io.getconf("PAGESIZE") ?? 4096,
		};
		return units;
	};
}

/** `rootPid` and all its descendants, or undefined if `rootPid` itself is gone. */
export function treeOf(
	rows: ProcessRow[],
	rootPid: number,
): ProcessRow[] | undefined {
	const childrenOf = new Map<number, ProcessRow[]>();
	let root: ProcessRow | undefined;
	for (const row of rows) {
		if (row.pid === rootPid) root = row;
		const siblings = childrenOf.get(row.ppid) ?? [];
		siblings.push(row);
		childrenOf.set(row.ppid, siblings);
	}
	if (!root) return undefined;
	const tree: ProcessRow[] = [];
	const seen = new Set<number>();
	const pending = [root];
	while (pending.length > 0) {
		const row = pending.pop() as ProcessRow;
		if (seen.has(row.pid)) continue; // guards against a pid-reuse cycle in a racy snapshot
		seen.add(row.pid);
		tree.push(row);
		pending.push(...(childrenOf.get(row.pid) ?? []));
	}
	return tree;
}

/**
 * Samples process trees by their root pid, remembering each one's previous CPU time so the next
 * sample can turn it into a percentage. A root that isn't asked for (its app stopped, or was
 * replaced by a new pid) is forgotten.
 */
export function createTreeSampler(io: StatsIo = defaultStatsIo) {
	const previous = new Map<number, { cpuMs: number; at: number }>();
	const linuxUnits = linuxUnitsFor(io);
	return async function sample(
		rootPids: number[],
		now: () => number = Date.now,
	): Promise<Map<number, TreeStats>> {
		const rows = await readProcessTable(io, linuxUnits);
		const at = now();
		for (const pid of [...previous.keys()]) {
			if (!rootPids.includes(pid)) previous.delete(pid);
		}
		const trees = new Map<number, ProcessRow[]>();
		for (const pid of rootPids) {
			const tree = treeOf(rows, pid);
			if (tree) trees.set(pid, tree);
			else previous.delete(pid);
		}
		const members = [...trees.values()].flat().map((row) => row.pid);
		const footprints =
			io.platform === "darwin" && members.length > 0
				? parseFootprints(await io.footprint(members))
				: new Map<number, number>();
		const result = new Map<number, TreeStats>();
		for (const [pid, tree] of trees) {
			let cpuMs = 0;
			let memory = 0;
			for (const row of tree) {
				cpuMs += row.cpuMs;
				memory += footprints.get(row.pid) ?? row.rssBytes;
			}
			const before = previous.get(pid);
			previous.set(pid, { cpuMs, at });
			const stats: TreeStats = { memory };
			if (before && at > before.at) {
				// A descendant that exited since the last sample takes its CPU time with it, so the
				// tree's total can drop - that reads as an idle interval, never a negative one.
				const used = Math.max(0, cpuMs - before.cpuMs);
				stats.cpu = Math.round((used / (at - before.at)) * 1000) / 10;
			}
			result.set(pid, stats);
		}
		return result;
	};
}
