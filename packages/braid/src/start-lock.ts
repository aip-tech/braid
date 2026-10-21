import { randomBytes } from "node:crypto";
import {
	linkSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	currentStartId,
	isSameProcess,
	type ProcessRecord,
} from "./process-identity.js";

/**
 * One braid manager per `.braid` directory, enforced from the moment a manager starts booting -
 * the pidfile alone can't do it, since it's only written once every plugin has loaded and every
 * process has forked, leaving a window where two `braid start`s could both see "nothing running"
 * and both start a whole stack. Held for the manager's whole life.
 *
 * Taken atomically: the lock's contents are written to a temp file first, then hard-linked into
 * place, which fails if a lock already exists - so a reader never sees a half-written one. A lock
 * whose holder is no longer the recorded process (see process-identity.ts) is stale and taken
 * over, by renaming it aside first: rename is atomic, so of two starters racing to take over the
 * same stale lock, only one can move it, and the other then sees the winner's lock and backs off.
 */

const LOCK_FILENAME = "start.lock";

function lockPathIn(dir: string): string {
	return join(dir, LOCK_FILENAME);
}

function readLock(path: string): ProcessRecord | undefined {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as ProcessRecord;
		return typeof parsed.pid === "number" ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function sameRecord(a: ProcessRecord | undefined, b: ProcessRecord): boolean {
	return a?.pid === b.pid && a.startedAt === b.startedAt;
}

function errorCode(error: unknown): unknown {
	return (error as { code?: unknown }).code;
}

/** The process holding `dir`'s start lock, if a live one does. */
export function findLiveStartLock(dir: string): ProcessRecord | undefined {
	const holder = readLock(lockPathIn(dir));
	return holder && isSameProcess(holder) ? holder : undefined;
}

/**
 * Takes `dir`'s start lock for this process, throwing if another live manager holds it. Returns
 * the function that releases it - which only ever removes this process's own lock.
 */
export function acquireStartLock(dir: string): () => void {
	const lockPath = lockPathIn(dir);
	const startId = currentStartId(process.pid);
	const mine: ProcessRecord = {
		pid: process.pid,
		startedAt: new Date().toISOString(),
		// Undefined off Linux - and then left out of the JSON entirely.
		startId,
	};
	const unique = `${process.pid}.${randomBytes(4).toString("hex")}`;
	const tmpPath = `${lockPath}.${unique}.tmp`;
	writeFileSync(tmpPath, JSON.stringify(mine), { mode: 0o600 });
	try {
		// Two attempts: the first may find a stale lock and move it aside; the second then succeeds
		// unless another starter got in between, in which case its lock is live and we back off.
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				linkSync(tmpPath, lockPath);
				return () => {
					if (sameRecord(readLock(lockPath), mine)) {
						rmSync(lockPath, { force: true });
					}
				};
			} catch (error) {
				if (errorCode(error) !== "EEXIST") throw error;
			}
			const holder = readLock(lockPath);
			if (holder && isSameProcess(holder)) {
				throw new Error(
					`braid already running or starting (pid ${holder.pid}).`,
				);
			}
			const asidePath = `${lockPath}.stale.${unique}`;
			try {
				renameSync(lockPath, asidePath);
			} catch (error) {
				// Someone else moved it first - go round again and see whose lock is there now.
				if (errorCode(error) !== "ENOENT") throw error;
				continue;
			}
			const moved = readLock(asidePath);
			if (holder !== undefined && !sameRecord(moved, holder)) {
				// Between reading the stale lock and moving it, another starter replaced it with its
				// own live one - which is what got moved. Put it back, and back off.
				try {
					linkSync(asidePath, lockPath);
				} catch {
					// already replaced again - whoever holds it now, it isn't us
				}
				rmSync(asidePath, { force: true });
				throw new Error(
					`braid already running or starting (pid ${moved?.pid ?? "unknown"}).`,
				);
			}
			rmSync(asidePath, { force: true });
		}
		throw new Error(
			`braid couldn't take the start lock at ${lockPath}; another start is racing this one.`,
		);
	} finally {
		rmSync(tmpPath, { force: true });
	}
}
