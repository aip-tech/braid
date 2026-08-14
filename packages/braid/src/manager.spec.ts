import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	findRunningPidfile,
	runManager,
	statusFromPidfile,
	stopFromPidfile,
} from "./manager.js";
import type { ProcessConfig } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "__fixtures__");

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(
	predicate: () => boolean,
	{ timeoutMs = 4000, intervalMs = 25 } = {},
): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("waitFor: timed out");
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}

function keepAliveConfig(name: string): ProcessConfig {
	return { name, command: "node", args: [join(FIXTURES, "keep-alive.js")] };
}

function exitFailConfig(name: string): ProcessConfig {
	return { name, command: "node", args: [join(FIXTURES, "exit-fail.js")] };
}

describe("runManager", () => {
	let tmpDir: string;
	let pidfilePath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "braid-test-"));
		pidfilePath = join(tmpDir, "run.json");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("forks every configured process, records their PIDs, and relays their prefixed output", async () => {
		const writeSpy = vi.spyOn(process.stdout, "write");
		const configs = [keepAliveConfig("one"), keepAliveConfig("two")];

		const managerPromise = runManager(configs, pidfilePath);

		await waitFor(() => existsSync(pidfilePath));
		const pidfile = JSON.parse(readFileSync(pidfilePath, "utf8"));
		expect(pidfile.workers).toHaveLength(2);
		expect(pidfile.workers.map((w: { name: string }) => w.name).sort()).toEqual(
			["one", "two"],
		);

		await waitFor(() =>
			pidfile.workers.every((w: { pid: number }) => isPidAlive(w.pid)),
		);
		await waitFor(() =>
			writeSpy.mock.calls.some((call) => String(call[0]).includes("[one]")),
		);
		await waitFor(() =>
			writeSpy.mock.calls.some((call) => String(call[0]).includes("[two]")),
		);

		expect(findRunningPidfile(pidfilePath)).toBeDefined();
		const status = statusFromPidfile(pidfilePath);
		expect(status.every((s) => s.alive)).toBe(true);

		const stopped = await stopFromPidfile(pidfilePath);
		expect(stopped.sort()).toEqual(["one", "two"]);

		const exitCode = await managerPromise;
		expect(exitCode).toBe(0);
		expect(existsSync(pidfilePath)).toBe(false);
		for (const worker of pidfile.workers) {
			expect(isPidAlive(worker.pid)).toBe(false);
		}

		writeSpy.mockRestore();
	}, 10000);

	it("kills every other worker and returns a non-zero exit code when one process crashes", async () => {
		const configs = [keepAliveConfig("ok"), exitFailConfig("bad")];

		const exitCode = await runManager(configs, pidfilePath);

		expect(exitCode).toBe(1);
		expect(existsSync(pidfilePath)).toBe(false);
	}, 10000);

	it("refuses to start a second manager against a pidfile that's still alive", async () => {
		const configs = [keepAliveConfig("solo")];
		const managerPromise = runManager(configs, pidfilePath);

		await waitFor(() => existsSync(pidfilePath));

		await expect(runManager(configs, pidfilePath)).rejects.toThrow(
			/already running/,
		);

		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 10000);
});

describe("pidfile helpers with no pidfile present", () => {
	const missingPath = join(tmpdir(), "braid-test-missing", "run.json");

	it("findRunningPidfile returns undefined", () => {
		expect(findRunningPidfile(missingPath)).toBeUndefined();
	});

	it("statusFromPidfile returns an empty array", () => {
		expect(statusFromPidfile(missingPath)).toEqual([]);
	});

	it("stopFromPidfile returns an empty array and does not throw", async () => {
		await expect(stopFromPidfile(missingPath)).resolves.toEqual([]);
	});
});
