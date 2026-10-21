import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Pid reuse makes "is pid N alive" a weak check: after a crash, a reboot or a container restart, a
 * stale pidfile can name pids that now belong to unrelated processes - and signalling those would
 * kill something braid never started. This module answers the stronger question "is pid N still
 * the same process that was recorded", so braid only ever trusts (or signals) its own.
 *
 * Two ways to tell, best first:
 * - On Linux, an exact identity recorded at spawn time: the boot id plus the process's start time
 *   in clock ticks since boot (`/proc/<pid>/stat` field 22). Both are fixed for the life of the
 *   process and survive wall-clock changes.
 * - Everywhere else (or for a record without one, e.g. a pidfile written by an older braid), the
 *   process's own start time must be no later than when it was recorded, plus a little slack: a
 *   reused pid always belongs to a process that started *after* the record was written. macOS
 *   stores the start time at exec, so a later clock step doesn't move it.
 * When neither can be determined (Windows, no `ps`), it falls back to plain liveness - the
 * behaviour braid had before this check existed.
 */

/** How much later than its recorded `startedAt` a process may appear to have started. Covers
 *  `ps`'s one-second resolution and the gap between fork() and the record being written. */
export const START_TIME_TOLERANCE_MS = 2000;

export type ProcessRecord = {
	pid: number;
	startedAt: string;
	startId?: string;
};

/** Everything this module reads from the OS, injectable so each platform's path can be tested on
 *  any platform. */
export type IdentityIo = {
	platform: NodeJS.Platform;
	readFile(path: string): string;
	/** Runs `ps` with `args`, returning stdout - including a partial stdout from a non-zero exit. */
	ps(args: string[]): string;
	isAlive(pid: number): boolean;
};

export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export const defaultIo: IdentityIo = {
	platform: process.platform,
	readFile: (path) => readFileSync(path, "utf8"),
	ps(args) {
		try {
			return execFileSync("ps", args, {
				encoding: "utf8",
				env: { ...process.env, LC_ALL: "C" },
				stdio: ["ignore", "pipe", "ignore"],
			});
		} catch (error) {
			// procps exits 1 whenever any requested pid is gone, but still prints the live ones.
			const stdout = (error as { stdout?: unknown }).stdout;
			return typeof stdout === "string" ? stdout : "";
		}
	},
	isAlive,
};

/** Field 22 (starttime, in clock ticks since boot) of a `/proc/<pid>/stat` line. The command
 *  name (field 2) is parenthesised and may itself contain spaces and parentheses, so fields are
 *  counted from after its *last* closing parenthesis. */
export function parseProcStatStartTime(stat: string): string | undefined {
	const afterName = stat
		.slice(stat.lastIndexOf(")") + 1)
		.trim()
		.split(/\s+/);
	// afterName[0] is field 3 (state), so field 22 is at index 19.
	const startTime = afterName[19];
	return startTime && /^\d+$/.test(startTime) ? startTime : undefined;
}

/** Parses `ps -o pid=,lstart=` output into pid -> start time (epoch ms). Rows come back sorted by
 *  pid, not request order, and padded with trailing spaces. */
export function parsePsStartTimes(output: string): Map<number, number> {
	const times = new Map<number, number>();
	for (const line of output.split("\n")) {
		const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
		if (!match) continue;
		// lstart is local time ("Wed Oct 21 15:26:31 2026"), which Date parses as local - right.
		const time = Date.parse(match[2] as string);
		if (!Number.isNaN(time)) times.set(Number(match[1]), time);
	}
	return times;
}

/** The exact identity of a live pid (Linux only), for recording at spawn time. */
export function currentStartId(
	pid: number,
	io: IdentityIo = defaultIo,
): string | undefined {
	if (io.platform !== "linux") return undefined;
	try {
		const bootId = io.readFile("/proc/sys/kernel/random/boot_id").trim();
		const startTime = parseProcStatStartTime(io.readFile(`/proc/${pid}/stat`));
		return bootId && startTime ? `${bootId}:${startTime}` : undefined;
	} catch {
		return undefined;
	}
}

/** Start times (epoch ms) for `pids`, from as few `ps` calls as possible. Missing pids are absent. */
export function processStartTimes(
	pids: number[],
	io: IdentityIo = defaultIo,
): Map<number, number> {
	if (pids.length === 0 || io.platform === "win32") return new Map();
	const batch = parsePsStartTimes(
		io.ps(["-o", "pid=,lstart=", "-p", pids.join(",")]),
	);
	// macOS rejects the whole batch (no output at all) if any one pid is out of its range, so a
	// batch that came back empty is retried one pid at a time before concluding nothing's there.
	if (batch.size > 0 || pids.length === 1) return batch;
	const times = new Map<number, number>();
	for (const pid of pids) {
		for (const [found, time] of parsePsStartTimes(
			io.ps(["-o", "pid=,lstart=", "-p", String(pid)]),
		)) {
			times.set(found, time);
		}
	}
	return times;
}

/**
 * The pids among `records` that are still the very processes recorded - see this module's doc
 * comment. One batched `ps` call covers every record that needs the start-time check.
 */
export function liveRecordedPids(
	records: ProcessRecord[],
	io: IdentityIo = defaultIo,
): Set<number> {
	const live = new Set<number>();
	const needStartTime: ProcessRecord[] = [];
	for (const record of records) {
		if (!io.isAlive(record.pid)) continue;
		if (record.startId !== undefined) {
			const current = currentStartId(record.pid, io);
			if (current !== undefined) {
				if (current === record.startId) live.add(record.pid);
				continue;
			}
		}
		needStartTime.push(record);
	}
	if (needStartTime.length === 0) return live;
	const startTimes = processStartTimes(
		needStartTime.map((record) => record.pid),
		io,
	);
	for (const record of needStartTime) {
		const startedAt = startTimes.get(record.pid);
		// Unknown start time (no ps, Windows): fall back to plain liveness, as before.
		if (
			startedAt === undefined ||
			startedAt <= Date.parse(record.startedAt) + START_TIME_TOLERANCE_MS
		) {
			live.add(record.pid);
		}
	}
	return live;
}

/** Single-record convenience over `liveRecordedPids`. */
export function isSameProcess(
	record: ProcessRecord,
	io: IdentityIo = defaultIo,
): boolean {
	return liveRecordedPids([record], io).has(record.pid);
}
