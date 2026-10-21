import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireStartLock, findLiveStartLock } from "./start-lock.js";

describe("start lock", () => {
	let dir: string;
	const lockPath = () => join(dir, "start.lock");

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "braid-lock-"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(dir, { recursive: true, force: true });
	});

	const deadPid = () => spawnSync(process.execPath, ["-e", "0"]).pid;

	it("takes the lock, refuses a second taker while it's held, and only its own release removes it", () => {
		const release = acquireStartLock(dir);
		expect(findLiveStartLock(dir)?.pid).toBe(process.pid);
		expect(() => acquireStartLock(dir)).toThrow(
			`braid already running or starting (pid ${process.pid}).`,
		);

		release();
		expect(existsSync(lockPath())).toBe(false);
		expect(findLiveStartLock(dir)).toBeUndefined();
		// No temp files left behind, held or not.
		expect(readdirSync(dir)).toEqual([]);
	});

	it("doesn't remove a lock that's since been taken over by someone else", () => {
		const release = acquireStartLock(dir);
		const other = JSON.stringify({ pid: 1, startedAt: "x" });
		writeFileSync(lockPath(), other);
		release();
		expect(readFileSync(lockPath(), "utf8")).toBe(other);
	});

	it("takes over a stale lock whose holder is dead, or is unreadable", () => {
		writeFileSync(
			lockPath(),
			JSON.stringify({ pid: deadPid(), startedAt: new Date().toISOString() }),
		);
		acquireStartLock(dir)();

		writeFileSync(lockPath(), "not json");
		acquireStartLock(dir)();
		writeFileSync(lockPath(), JSON.stringify({ startedAt: "no pid" }));
		acquireStartLock(dir)();
		expect(readdirSync(dir)).toEqual([]);
	});

	it("takes over a lock whose pid was reused by an unrelated, later-started process", async () => {
		const stray = spawn(process.execPath, [
			"-e",
			"setInterval(() => {}, 1000)",
		]);
		await new Promise<void>((resolve) => stray.once("spawn", () => resolve()));
		try {
			writeFileSync(
				lockPath(),
				JSON.stringify({
					pid: stray.pid,
					startedAt: new Date(Date.now() - 3600_000).toISOString(),
				}),
			);
			expect(findLiveStartLock(dir)).toBeUndefined();
			acquireStartLock(dir)();
		} finally {
			stray.kill();
		}
	});

	it("lets exactly one of several racing starters win", () => {
		const results = [0, 1, 2].map(() => {
			try {
				return acquireStartLock(dir);
			} catch {
				return undefined;
			}
		});
		expect(results.filter(Boolean)).toHaveLength(1);
	});
});
