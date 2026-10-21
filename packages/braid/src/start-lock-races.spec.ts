import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The takeover races in start-lock.ts depend on another starter acting in the gap between two
// filesystem calls - not something two real processes can be made to hit on cue. These hooks run
// a stand-in for that other starter at exactly that point, around the real fs calls.
const hooks = vi.hoisted(() => ({
	beforeRename: undefined as undefined | ((from: string) => void),
	afterRename: undefined as undefined | ((to: string) => void),
	link: undefined as undefined | (() => void),
}));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		renameSync: (from: string, to: string) => {
			hooks.beforeRename?.(from);
			actual.renameSync(from, to);
			hooks.afterRename?.(to);
		},
		linkSync: (existing: string, path: string) => {
			hooks.link?.();
			actual.linkSync(existing, path);
		},
	};
});

const { acquireStartLock } = await import("./start-lock.js");

describe("start lock takeover races", () => {
	let dir: string;
	const lockPath = () => join(dir, "start.lock");
	const staleLock = () =>
		JSON.stringify({
			pid: spawnSync(process.execPath, ["-e", "0"]).pid,
			startedAt: new Date().toISOString(),
		});
	const liveLock = JSON.stringify({
		pid: process.pid,
		startedAt: new Date().toISOString(),
	});

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "braid-lock-race-"));
		hooks.beforeRename = undefined;
		hooks.afterRename = undefined;
		hooks.link = undefined;
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("goes round again if another starter moved the stale lock aside first", () => {
		writeFileSync(lockPath(), staleLock());
		hooks.beforeRename = (from) => {
			hooks.beforeRename = undefined;
			rmSync(from); // the other starter's rename got there first
		};
		expect(() => acquireStartLock(dir)()).not.toThrow();
	});

	it("puts back, and backs off from, a live lock that replaced the stale one mid-takeover", () => {
		writeFileSync(lockPath(), staleLock());
		hooks.beforeRename = (from) => {
			hooks.beforeRename = undefined;
			writeFileSync(from, liveLock); // the other starter took over in the gap
		};
		expect(() => acquireStartLock(dir)).toThrow(
			`braid already running or starting (pid ${process.pid}).`,
		);
		expect(readFileSync(lockPath(), "utf8")).toBe(liveLock);
	});

	it("still backs off when the lock it moved aside was unreadable, or was replaced again before it could be put back", () => {
		writeFileSync(lockPath(), staleLock());
		hooks.beforeRename = (from) => {
			hooks.beforeRename = undefined;
			writeFileSync(from, "half-written");
		};
		hooks.afterRename = (to) => {
			if (!to.includes(".stale.")) return;
			hooks.afterRename = undefined;
			writeFileSync(lockPath(), liveLock); // and a third starter is already in place
		};
		expect(() => acquireStartLock(dir)).toThrow(
			"braid already running or starting (pid unknown).",
		);
		expect(readFileSync(lockPath(), "utf8")).toBe(liveLock);
	});

	it("gives up rather than looping if the lock keeps reappearing", () => {
		writeFileSync(lockPath(), staleLock());
		hooks.link = () => {
			throw Object.assign(new Error("exists"), { code: "EEXIST" });
		};
		expect(() => acquireStartLock(dir)).toThrow(
			"another start is racing this one",
		);
	});

	it("propagates filesystem errors other than the expected races", () => {
		hooks.link = () => {
			throw Object.assign(new Error("denied"), { code: "EACCES" });
		};
		expect(() => acquireStartLock(dir)).toThrow("denied");

		hooks.link = undefined;
		writeFileSync(lockPath(), staleLock());
		hooks.beforeRename = () => {
			throw Object.assign(new Error("not permitted"), { code: "EPERM" });
		};
		expect(() => acquireStartLock(dir)).toThrow("not permitted");
	});
});
