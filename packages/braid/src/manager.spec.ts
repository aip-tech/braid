import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
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

function chattyConfig(name: string): ProcessConfig {
	return { name, command: "node", args: [join(FIXTURES, "chatty.js")] };
}

/** A keep-alive process restarted whenever `watchFilePath` changes. */
function watchedConfig(name: string, watchFilePath: string): ProcessConfig {
	return {
		name,
		command: "node",
		args: [join(FIXTURES, "keep-alive.js")],
		watch: [watchFilePath],
		ext: "trigger",
	};
}

/** A process restarted on a watch trigger that only prints "ready-marker <pid>" `delayMs` after each (re)start. */
function watchedSlowConfig(
	name: string,
	watchFilePath: string,
	delayMs: number,
): ProcessConfig {
	return {
		name,
		command: "node",
		args: [join(FIXTURES, "slow-start.js"), String(delayMs)],
		watch: [watchFilePath],
		ext: "trigger",
	};
}

type DependsOnRun = NonNullable<NonNullable<ProcessConfig["dependsOn"]>["run"]>;

function dependentConfig(
	name: string,
	processes: string[],
	run?: DependsOnRun,
): ProcessConfig {
	return {
		...keepAliveConfig(name),
		dependsOn: { processes, run },
	};
}

function pidfileWorker(
	pidfilePath: string,
	name: string,
): { name: string; pid: number } | undefined {
	const pidfile = JSON.parse(readFileSync(pidfilePath, "utf8"));
	return pidfile.workers.find(
		(worker: { name: string }) => worker.name === name,
	);
}

/**
 * Writes a fresh value to a watched trigger file to cause a real restart. The watcher takes a
 * moment to attach after start, so writing right away can go unnoticed - a short settle delay
 * first makes sure it's actually watching by the time this write happens.
 */
async function triggerWatchedRestart(watchFilePath: string): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 800));
	writeFileSync(watchFilePath, String(Date.now()));
}

/** Mirrors chatty.js's own line-generation exactly, so the expected byte count is computed, not guessed. */
function expectedChattyBytes(prefix: string): number {
	let total = 0;
	for (let i = 0; i < 500; i++) {
		const line = `chatty-line-${i}-${"x".repeat(40)}`;
		total += prefix.length + line.length + 1; // prefix + content + newline
	}
	return total;
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

	it("forks every configured process, records their PIDs, and persists their prefixed output to per-process log files", async () => {
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
		const oneLog = join(tmpDir, "logs", "one.log");
		const twoLog = join(tmpDir, "logs", "two.log");
		await waitFor(
			() =>
				existsSync(oneLog) && readFileSync(oneLog, "utf8").includes("[one]"),
		);
		await waitFor(
			() =>
				existsSync(twoLog) && readFileSync(twoLog, "utf8").includes("[two]"),
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
	}, 10000);

	it("kills every other worker and returns a non-zero exit code when one process crashes", async () => {
		const configs = [keepAliveConfig("ok"), exitFailConfig("bad")];

		const exitCode = await runManager(configs, pidfilePath);

		expect(exitCode).toBe(1);
		expect(existsSync(pidfilePath)).toBe(false);
		// The still-alive sibling gets a "stopping" note in its own log; the crashing process
		// itself doesn't (it crashed, braid didn't stop it) - regression check for a real bug
		// where the crashing process's own ChildProcess.exitCode hadn't caught up yet at the
		// moment this ran, misreporting it as stopped too.
		expect(readFileSync(join(tmpDir, "logs", "ok.log"), "utf8")).toContain(
			"braid: stopping",
		);
		expect(readFileSync(join(tmpDir, "logs", "bad.log"), "utf8")).not.toContain(
			"braid: stopping",
		);
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

describe("runManager watch", () => {
	let tmpDir: string;
	let pidfilePath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "braid-watch-test-"));
		pidfilePath = join(tmpDir, "run.json");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it('restarts a plain `command: "node"` process and rotates its log when its watched path changes', async () => {
		const watchFile = join(tmpDir, "watch.trigger");
		writeFileSync(watchFile, "0");
		const configs = [
			{
				name: "api",
				command: "node",
				args: [join(FIXTURES, "keep-alive.js")],
				watch: [watchFile],
				ext: "trigger",
			},
		];
		const managerPromise = runManager(configs, pidfilePath);
		const logPath = join(tmpDir, "logs", "api.log");
		const rotatedLogPath = `${logPath}.1`;

		await waitFor(
			() =>
				existsSync(logPath) &&
				readFileSync(logPath, "utf8").includes("started"),
		);

		await triggerWatchedRestart(watchFile);

		// The log is rotated on a watch-triggered restart (see the logger core plugin), so the
		// original "started <pid>" line ends up in the rotated backup and a new one lands active.
		await waitFor(
			() =>
				existsSync(rotatedLogPath) &&
				existsSync(logPath) &&
				readFileSync(logPath, "utf8").includes("started"),
			{ timeoutMs: 10000 },
		);
		const originalPid = readFileSync(rotatedLogPath, "utf8").match(
			/started (\d+)/,
		)?.[1];
		const restartedPid = readFileSync(logPath, "utf8").match(
			/started (\d+)/,
		)?.[1];
		expect(originalPid).toBeDefined();
		expect(restartedPid).toBeDefined();
		expect(restartedPid).not.toBe(originalPid);

		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 20000);
});

describe("runManager log rotation", () => {
	let tmpDir: string;
	let pidfilePath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "braid-rotate-test-"));
		pidfilePath = join(tmpDir, "run.json");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("rotates a chatty process's log on crossing maxSizeBytes, preserving every byte across the two files", async () => {
		const totalBytes = expectedChattyBytes("[noisy] ");
		// Above half of totalBytes so exactly one rotation happens.
		const maxSizeBytes = Math.round(totalBytes * 0.65);

		const configs = [chattyConfig("noisy")];
		const managerPromise = runManager(configs, pidfilePath, {
			logs: { maxSizeBytes },
		});

		await waitFor(() => existsSync(pidfilePath));
		const logPath = join(tmpDir, "logs", "noisy.log");
		const rotatedPath = `${logPath}.1`;

		await waitFor(() => {
			const rotated = existsSync(rotatedPath) ? statSync(rotatedPath).size : 0;
			const active = existsSync(logPath) ? statSync(logPath).size : 0;
			return rotated + active >= totalBytes;
		});

		const rotatedSize = statSync(rotatedPath).size;
		const activeSize = existsSync(logPath) ? statSync(logPath).size : 0;
		expect(rotatedSize).toBeGreaterThan(0);
		// +50 margin for chatty.js's one extra "started <pid>" line.
		expect(rotatedSize + activeSize).toBeGreaterThanOrEqual(totalBytes);
		expect(rotatedSize + activeSize).toBeLessThan(totalBytes + 50);

		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 10000);
});

describe("runManager plugin support", () => {
	let tmpDir: string;
	let pidfilePath: string;
	const PLUGIN_FIXTURES = join(FIXTURES, "plugins");

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "braid-plugin-test-"));
		pidfilePath = join(tmpDir, "run.json");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	async function fetchWithToken(
		pidfile: { controlPort: number; controlToken: string },
		path: string,
	): Promise<Response> {
		return fetch(`http://127.0.0.1:${pidfile.controlPort}${path}`, {
			headers: { Authorization: `Bearer ${pidfile.controlToken}` },
		});
	}

	it("records controlPort/controlToken in the pidfile and serves the core /api/status route", async () => {
		const configs = [keepAliveConfig("one"), keepAliveConfig("two")];
		const managerPromise = runManager(configs, pidfilePath);

		await waitFor(() => existsSync(pidfilePath));
		const pidfile = JSON.parse(readFileSync(pidfilePath, "utf8"));
		expect(typeof pidfile.controlPort).toBe("number");
		expect(typeof pidfile.controlToken).toBe("string");
		expect(pidfile.controlToken.length).toBeGreaterThan(0);

		await waitFor(() =>
			pidfile.workers.every((w: { pid: number }) => isPidAlive(w.pid)),
		);

		const res = await fetchWithToken(pidfile, "/api/status");
		expect(res.status).toBe(200);
		const body = (await res.json()) as Array<{ name: string; alive: boolean }>;
		const expected = statusFromPidfile(pidfilePath)
			.map((w) => ({ name: w.name, alive: w.alive }))
			.sort((a, b) => a.name.localeCompare(b.name));
		expect(
			body
				.map((w) => ({ name: w.name, alive: w.alive }))
				.sort((a, b) => a.name.localeCompare(b.name)),
		).toEqual(expected);

		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 10000);

	it("registers an external plugin's route and delivers it a processStart event before any could be missed", async () => {
		const writeSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		const configs = [keepAliveConfig("solo")];
		const managerPromise = runManager(configs, pidfilePath, {
			plugins: [join(PLUGIN_FIXTURES, "ok-plugin.js")],
			configPath: join(tmpDir, "braid.config.ts"),
		});

		await waitFor(() => existsSync(pidfilePath));
		const pidfile = JSON.parse(readFileSync(pidfilePath, "utf8"));

		const res = await fetchWithToken(pidfile, "/ok");
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("ok");

		await waitFor(() =>
			writeSpy.mock.calls.some(
				(call) =>
					String(call[0]).includes("[plugin:ok]") &&
					String(call[0]).includes("saw processStart"),
			),
		);

		writeSpy.mockRestore();
		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 10000);

	it("isolates a throwing external plugin: the manager, its other routes, and its workers keep working", async () => {
		const writeSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		const configs = [keepAliveConfig("solo")];
		const managerPromise = runManager(configs, pidfilePath, {
			plugins: [
				join(PLUGIN_FIXTURES, "throwing-plugin.js"),
				join(PLUGIN_FIXTURES, "ok-plugin.js"),
			],
			configPath: join(tmpDir, "braid.config.ts"),
		});

		await waitFor(() => existsSync(pidfilePath));
		const pidfile = JSON.parse(readFileSync(pidfilePath, "utf8"));

		await waitFor(() =>
			pidfile.workers.every((w: { pid: number }) => isPidAlive(w.pid)),
		);

		const okRes = await fetchWithToken(pidfile, "/ok");
		expect(okRes.status).toBe(200);
		const statusRes = await fetchWithToken(pidfile, "/api/status");
		expect(statusRes.status).toBe(200);
		expect(
			writeSpy.mock.calls.some(
				(call) =>
					String(call[0]).includes("[plugin:throwing]") &&
					String(call[0]).includes("failed to register: boom"),
			),
		).toBe(true);

		writeSpy.mockRestore();
		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 10000);
});

describe("runManager manual process control", () => {
	let tmpDir: string;
	let pidfilePath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "braid-manual-control-test-"));
		pidfilePath = join(tmpDir, "run.json");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	async function postAction(
		pidfile: { controlPort: number; controlToken: string },
		action: "stop" | "restart",
		name: string,
	): Promise<Response> {
		return fetch(
			`http://127.0.0.1:${pidfile.controlPort}/api/processes/${action}?name=${name}`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${pidfile.controlToken}` },
			},
		);
	}

	async function fetchStatus(pidfile: {
		controlPort: number;
		controlToken: string;
	}): Promise<Response> {
		return fetch(`http://127.0.0.1:${pidfile.controlPort}/api/status`, {
			headers: { Authorization: `Bearer ${pidfile.controlToken}` },
		});
	}

	it("stops one process by name via the control server, leaving the others (and the daemon) running", async () => {
		const configs = [keepAliveConfig("one"), keepAliveConfig("two")];
		const managerPromise = runManager(configs, pidfilePath);
		await waitFor(() => existsSync(pidfilePath));
		const pidfile = JSON.parse(readFileSync(pidfilePath, "utf8"));
		await waitFor(() =>
			pidfile.workers.every((w: { pid: number }) => isPidAlive(w.pid)),
		);
		const onePid = pidfileWorker(pidfilePath, "one")?.pid as number;

		expect((await postAction(pidfile, "stop", "one")).status).toBe(200);
		await waitFor(() => !isPidAlive(onePid));

		expect((await fetchStatus(pidfile)).status).toBe(200);
		expect(isPidAlive(pidfileWorker(pidfilePath, "two")?.pid as number)).toBe(
			true,
		);

		// stopFromPidfile, called in-process (as every test here does), can't tree-kill its own
		// pid - it relies on the manager's natural "every worker has exited" shutdown, which stays
		// deliberately suppressed while anything is manually-stopped (that's the very behavior this
		// suite is testing). Bring "one" back first so cleanup's stopFromPidfile has a clean exit
		// cascade to trigger, like every other test in this file gets for free.
		await postAction(pidfile, "restart", "one");
		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 10000);

	it("does not shut the daemon down when the only configured process is manually stopped", async () => {
		const configs = [keepAliveConfig("solo")];
		const managerPromise = runManager(configs, pidfilePath);
		await waitFor(() => existsSync(pidfilePath));
		const pidfile = JSON.parse(readFileSync(pidfilePath, "utf8"));
		await waitFor(() =>
			pidfile.workers.every((w: { pid: number }) => isPidAlive(w.pid)),
		);

		expect((await postAction(pidfile, "stop", "solo")).status).toBe(200);

		// Give shutdownIfEveryWorkerIsDone a moment to (wrongly) fire, if it were going to.
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(existsSync(pidfilePath)).toBe(true);
		expect((await fetchStatus(pidfile)).status).toBe(200);

		// See the comment in the test above - bring "solo" back so cleanup can trigger a real exit.
		await postAction(pidfile, "restart", "solo");
		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 10000);

	it("restarts a plain (non-watched) process by name, giving it a fresh pid", async () => {
		const configs = [keepAliveConfig("solo")];
		const managerPromise = runManager(configs, pidfilePath);
		await waitFor(() => existsSync(pidfilePath));
		await waitFor(() => {
			const solo = pidfileWorker(pidfilePath, "solo");
			return solo !== undefined && isPidAlive(solo.pid);
		});
		const pidfile = JSON.parse(readFileSync(pidfilePath, "utf8"));
		const before = pidfileWorker(pidfilePath, "solo")?.pid;

		expect((await postAction(pidfile, "restart", "solo")).status).toBe(200);

		const after = pidfileWorker(pidfilePath, "solo")?.pid;
		expect(after).not.toBe(before);
		expect(isPidAlive(after as number)).toBe(true);

		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 10000);

	it("cascades to a dependsOn dependent after a manual restart, same as a watch-triggered one would", async () => {
		const configs = [
			keepAliveConfig("api"),
			dependentConfig("client", ["api"]),
		];
		const managerPromise = runManager(configs, pidfilePath);
		await waitFor(() => existsSync(pidfilePath));
		await waitFor(() => {
			const client = pidfileWorker(pidfilePath, "client");
			return client !== undefined && isPidAlive(client.pid);
		});
		const pidfile = JSON.parse(readFileSync(pidfilePath, "utf8"));
		const clientBefore = pidfileWorker(pidfilePath, "client")?.pid;

		expect((await postAction(pidfile, "restart", "api")).status).toBe(200);

		await waitFor(
			() => pidfileWorker(pidfilePath, "client")?.pid !== clientBefore,
			{ timeoutMs: 10000 },
		);
		expect(
			isPidAlive(pidfileWorker(pidfilePath, "client")?.pid as number),
		).toBe(true);

		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 20000);

	it("returns 409 busy for a second restart of the same name while the first is still running its onRestart hook", async () => {
		const configs = [
			{
				...keepAliveConfig("api"),
				onRestart: {
					command: "node",
					args: [join(FIXTURES, "slow-hook.js"), "500"],
				},
			},
		];
		const managerPromise = runManager(configs, pidfilePath);
		await waitFor(() => existsSync(pidfilePath));
		await waitFor(() => {
			const api = pidfileWorker(pidfilePath, "api");
			return api !== undefined && isPidAlive(api.pid);
		});
		const pidfile = JSON.parse(readFileSync(pidfilePath, "utf8"));

		const first = postAction(pidfile, "restart", "api");
		// Long enough after restartProcessByName's synchronous restarting.add(), well before the
		// 500ms hook finishes - the second call should land squarely in the busy window.
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect((await postAction(pidfile, "restart", "api")).status).toBe(409);
		expect((await first).status).toBe(200);

		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 10000);

	it("returns 404 for an unknown process name on both stop and restart", async () => {
		const configs = [keepAliveConfig("solo")];
		const managerPromise = runManager(configs, pidfilePath);
		await waitFor(() => existsSync(pidfilePath));
		const pidfile = JSON.parse(readFileSync(pidfilePath, "utf8"));

		expect((await postAction(pidfile, "stop", "ghost")).status).toBe(404);
		expect((await postAction(pidfile, "restart", "ghost")).status).toBe(404);

		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 10000);

	it("restarting a manually-stopped process brings it back and un-marks it", async () => {
		const configs = [keepAliveConfig("one"), keepAliveConfig("two")];
		const managerPromise = runManager(configs, pidfilePath);
		await waitFor(() => existsSync(pidfilePath));
		const pidfile = JSON.parse(readFileSync(pidfilePath, "utf8"));
		await waitFor(() =>
			pidfile.workers.every((w: { pid: number }) => isPidAlive(w.pid)),
		);

		expect((await postAction(pidfile, "stop", "one")).status).toBe(200);
		await waitFor(
			() => !isPidAlive(pidfileWorker(pidfilePath, "one")?.pid as number),
		);

		expect((await postAction(pidfile, "restart", "one")).status).toBe(200);
		expect(isPidAlive(pidfileWorker(pidfilePath, "one")?.pid as number)).toBe(
			true,
		);

		// "one" is no longer manually-stopped after being restarted - stopping "two" next (the
		// only *other* process) must not be mistaken for "everyone's finished" and shut the daemon
		// down, since "one" is genuinely alive and running, not just excluded via the flag.
		expect((await postAction(pidfile, "stop", "two")).status).toBe(200);
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(existsSync(pidfilePath)).toBe(true);

		// See the comment in this describe block's first test - bring "two" back too, so cleanup's
		// stopFromPidfile (in-process, can't kill its own pid) has a real exit cascade to trigger.
		await postAction(pidfile, "restart", "two");
		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 10000);
});

describe("runManager dependsOn", () => {
	let tmpDir: string;
	let pidfilePath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "braid-depends-test-"));
		pidfilePath = join(tmpDir, "run.json");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("rejects a circular dependsOn before spawning anything", async () => {
		const configs = [dependentConfig("a", ["b"]), dependentConfig("b", ["a"])];

		await expect(runManager(configs, pidfilePath)).rejects.toThrow(
			/circular restart dependency/,
		);
		expect(existsSync(pidfilePath)).toBe(false);
	});

	it("rejects a dependsOn.processes entry naming an unconfigured process", async () => {
		const configs = [dependentConfig("client", ["missing-api"])];

		await expect(runManager(configs, pidfilePath)).rejects.toThrow(
			/depends on unknown process "missing-api"/,
		);
		expect(existsSync(pidfilePath)).toBe(false);
	});

	it("stops a dependent, runs its hook, and restarts it once its dependency restarts via a watch trigger", async () => {
		const watchFile = join(tmpDir, "watch.trigger");
		writeFileSync(watchFile, "0");
		const markerFile = join(tmpDir, "generated.log");

		const configs = [
			watchedConfig("api", watchFile),
			dependentConfig("client", ["api"], {
				command: "node",
				args: [join(FIXTURES, "generate-hook.js"), markerFile],
			}),
		];
		const managerPromise = runManager(configs, pidfilePath);

		await waitFor(() => existsSync(pidfilePath));
		await waitFor(() => {
			const client = pidfileWorker(pidfilePath, "client");
			return client !== undefined && isPidAlive(client.pid);
		});
		const clientBefore = pidfileWorker(pidfilePath, "client");

		// A real watch-triggered restart of "api", not a simulated one.
		await triggerWatchedRestart(watchFile);

		await waitFor(() => existsSync(markerFile), { timeoutMs: 10000 });
		await waitFor(
			() => {
				const client = pidfileWorker(pidfilePath, "client");
				return (
					client !== undefined &&
					client.pid !== clientBefore?.pid &&
					isPidAlive(client.pid)
				);
			},
			{ timeoutMs: 10000 },
		);

		// Regression: the hook's own stdout used to reach the log completely unprefixed, unlike
		// every other process's output.
		const clientLog = join(tmpDir, "logs", "client.log");
		await waitFor(() =>
			readFileSync(clientLog, "utf8").includes("[client] generate-hook ran"),
		);
		expect(readFileSync(clientLog, "utf8")).toContain(
			"braid: stopping (dependency restarted)",
		);

		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 20000);

	it("retries a failing hook until it succeeds, then restarts the dependent", async () => {
		const watchFile = join(tmpDir, "watch.trigger");
		writeFileSync(watchFile, "0");
		const counterFile = join(tmpDir, "attempts.txt");
		const markerFile = join(tmpDir, "generated.log");

		const configs = [
			watchedConfig("api", watchFile),
			dependentConfig("client", ["api"], {
				command: "node",
				args: [
					join(FIXTURES, "flaky-hook.js"),
					counterFile,
					markerFile,
					"2", // fails twice, then succeeds
				],
				retries: 5,
				retryDelayMs: 50,
			}),
		];
		const managerPromise = runManager(configs, pidfilePath);

		await waitFor(() => existsSync(pidfilePath));
		await waitFor(() => {
			const client = pidfileWorker(pidfilePath, "client");
			return client !== undefined && isPidAlive(client.pid);
		});
		const clientBefore = pidfileWorker(pidfilePath, "client");

		await triggerWatchedRestart(watchFile);

		await waitFor(
			() => {
				const client = pidfileWorker(pidfilePath, "client");
				return (
					client !== undefined &&
					client.pid !== clientBefore?.pid &&
					isPidAlive(client.pid)
				);
			},
			{ timeoutMs: 10000 },
		);
		expect(readFileSync(counterFile, "utf8")).toBe("2");
		expect(existsSync(markerFile)).toBe(true);

		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 20000);

	it("leaves the dependent stopped, and logs why, when its hook keeps failing past its retries", async () => {
		const writeSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		const watchFile = join(tmpDir, "watch.trigger");
		writeFileSync(watchFile, "0");

		const configs = [
			watchedConfig("api", watchFile),
			dependentConfig("client", ["api"], {
				command: "node",
				args: [join(FIXTURES, "always-fail-hook.js")],
				retries: 1,
				retryDelayMs: 20,
			}),
		];
		const managerPromise = runManager(configs, pidfilePath);

		await waitFor(() => existsSync(pidfilePath));
		await waitFor(() => {
			const client = pidfileWorker(pidfilePath, "client");
			return client !== undefined && isPidAlive(client.pid);
		});
		const clientBefore = pidfileWorker(pidfilePath, "client");

		await triggerWatchedRestart(watchFile);

		await waitFor(() => !isPidAlive(clientBefore?.pid as number), {
			timeoutMs: 10000,
		});
		await waitFor(
			() =>
				writeSpy.mock.calls.some((call) =>
					String(call[0]).includes(
						'"client": dependency hook "node" kept failing',
					),
				),
			{ timeoutMs: 10000 },
		);

		// Gave up after retrying - the dependent was not respawned.
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(isPidAlive(clientBefore?.pid as number)).toBe(false);
		const clientAfter = pidfileWorker(pidfilePath, "client");
		expect(clientAfter?.pid).toBe(clientBefore?.pid);

		// Also visible via `braid logs`/`--follow`, not just daemon.log - previously this
		// diagnostic only ever reached process.stderr (daemon.log), invisible there.
		const clientLog = join(tmpDir, "logs", "client.log");
		expect(readFileSync(clientLog, "utf8")).toContain(
			'[client] braid: dependency hook "node" kept failing',
		);

		writeSpy.mockRestore();
		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 20000);

	it("leaves the dependent stopped when its hook command doesn't exist at all", async () => {
		const writeSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		const watchFile = join(tmpDir, "watch.trigger");
		writeFileSync(watchFile, "0");

		const configs = [
			watchedConfig("api", watchFile),
			dependentConfig("client", ["api"], {
				command: "braid-test-command-that-does-not-exist",
				retries: 1,
				retryDelayMs: 20,
			}),
		];
		const managerPromise = runManager(configs, pidfilePath);

		await waitFor(() => existsSync(pidfilePath));
		await waitFor(() => {
			const client = pidfileWorker(pidfilePath, "client");
			return client !== undefined && isPidAlive(client.pid);
		});
		const clientBefore = pidfileWorker(pidfilePath, "client");

		await triggerWatchedRestart(watchFile);

		await waitFor(() => !isPidAlive(clientBefore?.pid as number), {
			timeoutMs: 10000,
		});
		await waitFor(
			() =>
				writeSpy.mock.calls.some((call) =>
					String(call[0]).includes(
						'"client": dependency hook "braid-test-command-that-does-not-exist" kept failing',
					),
				),
			{ timeoutMs: 10000 },
		);

		writeSpy.mockRestore();
		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 20000);
});

describe("runManager onRestart", () => {
	let tmpDir: string;
	let pidfilePath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "braid-onrestart-test-"));
		pidfilePath = join(tmpDir, "run.json");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("runs its own onRestart hook after a watch-triggered restart, with no dependents involved", async () => {
		const watchFile = join(tmpDir, "watch.trigger");
		writeFileSync(watchFile, "0");
		const markerFile = join(tmpDir, "generated.log");

		const configs = [
			{
				...watchedConfig("api", watchFile),
				onRestart: {
					command: "node",
					args: [join(FIXTURES, "generate-hook.js"), markerFile],
				},
			},
		];
		const managerPromise = runManager(configs, pidfilePath);

		await waitFor(() => existsSync(pidfilePath));
		await waitFor(() => {
			const api = pidfileWorker(pidfilePath, "api");
			return api !== undefined && isPidAlive(api.pid);
		});
		const apiBefore = pidfileWorker(pidfilePath, "api");

		await triggerWatchedRestart(watchFile);

		await waitFor(() => existsSync(markerFile), { timeoutMs: 10000 });
		const apiLog = join(tmpDir, "logs", "api.log");
		await waitFor(() =>
			readFileSync(apiLog, "utf8").includes("[api] generate-hook ran"),
		);
		// A watch-triggered restart only kills/respawns the worker's inner app process - the outer
		// forked worker (and its pidfile entry) never changes for this kind of restart.
		expect(pidfileWorker(pidfilePath, "api")?.pid).toBe(apiBefore?.pid);

		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 20000);

	it("does not notify a dependsOn'd dependent when the trigger's own onRestart hook keeps failing", async () => {
		const writeSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		const watchFile = join(tmpDir, "watch.trigger");
		writeFileSync(watchFile, "0");

		const configs = [
			{
				...watchedConfig("api", watchFile),
				onRestart: {
					command: "node",
					args: [join(FIXTURES, "always-fail-hook.js")],
					retries: 1,
					retryDelayMs: 20,
				},
			},
			dependentConfig("client", ["api"]),
		];
		const managerPromise = runManager(configs, pidfilePath);

		await waitFor(() => existsSync(pidfilePath));
		await waitFor(() => {
			const client = pidfileWorker(pidfilePath, "client");
			return client !== undefined && isPidAlive(client.pid);
		});
		const clientBefore = pidfileWorker(pidfilePath, "client");

		await triggerWatchedRestart(watchFile);

		await waitFor(
			() =>
				writeSpy.mock.calls.some((call) =>
					String(call[0]).includes(
						'"api": onRestart hook "node" kept failing; not notifying dependents',
					),
				),
			{ timeoutMs: 10000 },
		);

		// Gave the hook a moment past the failure log to (wrongly) cascade, if it were going to.
		await new Promise((resolve) => setTimeout(resolve, 300));
		const clientAfter = pidfileWorker(pidfilePath, "client");
		expect(clientAfter?.pid).toBe(clientBefore?.pid);
		expect(isPidAlive(clientAfter?.pid as number)).toBe(true);

		writeSpy.mockRestore();
		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 20000);
});

describe("runManager readyPattern", () => {
	let tmpDir: string;
	let pidfilePath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "braid-ready-test-"));
		pidfilePath = join(tmpDir, "run.json");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("holds off a dependent's restart until the dependency's own output matches readyPattern", async () => {
		const watchFile = join(tmpDir, "watch.trigger");
		writeFileSync(watchFile, "0");
		const markerFile = join(tmpDir, "generated.log");
		const readyDelayMs = 1500;

		const configs = [
			{
				...watchedSlowConfig("api", watchFile, readyDelayMs),
				readyPattern: "ready-marker",
			},
			dependentConfig("client", ["api"], {
				command: "node",
				args: [join(FIXTURES, "generate-hook.js"), markerFile],
			}),
		];
		const managerPromise = runManager(configs, pidfilePath);

		await waitFor(() => existsSync(pidfilePath));
		await waitFor(() => {
			const client = pidfileWorker(pidfilePath, "client");
			return client !== undefined && isPidAlive(client.pid);
		});

		const triggeredAt = Date.now();
		await triggerWatchedRestart(watchFile);
		// A deliberately longer cap than this file's other watch/restart tests: this one stacks an
		// extra fixed readyDelayMs (1500ms) on top of the usual settle/spawn overhead, leaving it
		// with less slack on a loaded CI runner even at the same outer test timeout.
		await waitFor(() => existsSync(markerFile), { timeoutMs: 20000 });

		// Some slack for scheduling jitter, but this proves the hook waited for readiness rather
		// than firing the moment "api" merely decided to restart.
		expect(Date.now() - triggeredAt).toBeGreaterThanOrEqual(readyDelayMs - 300);

		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 30000);

	it("logs and proceeds anyway once readyTimeoutMs elapses without a match", async () => {
		const writeSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		const watchFile = join(tmpDir, "watch.trigger");
		writeFileSync(watchFile, "0");

		const configs = [
			{
				...watchedConfig("api", watchFile),
				readyPattern: "this-will-never-appear-in-output",
				readyTimeoutMs: 300,
			},
			dependentConfig("client", ["api"]),
		];
		const managerPromise = runManager(configs, pidfilePath);

		await waitFor(() => existsSync(pidfilePath));
		await waitFor(() => {
			const client = pidfileWorker(pidfilePath, "client");
			return client !== undefined && isPidAlive(client.pid);
		});
		const clientBefore = pidfileWorker(pidfilePath, "client");

		await triggerWatchedRestart(watchFile);

		await waitFor(
			() =>
				writeSpy.mock.calls.some((call) =>
					String(call[0]).includes(
						'"api": readyPattern never matched within 300ms; proceeding anyway',
					),
				),
			{ timeoutMs: 10000 },
		);
		await waitFor(
			() => {
				const client = pidfileWorker(pidfilePath, "client");
				return (
					client !== undefined &&
					client.pid !== clientBefore?.pid &&
					isPidAlive(client.pid)
				);
			},
			{ timeoutMs: 10000 },
		);

		writeSpy.mockRestore();
		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 20000);
});

describe("runManager beforeRestart", () => {
	let tmpDir: string;
	let pidfilePath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "braid-before-restart-test-"));
		pidfilePath = join(tmpDir, "run.json");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("throws at startup when beforeRestart is set without watch", async () => {
		const configs = [
			{
				name: "api",
				command: "node",
				args: [join(FIXTURES, "keep-alive.js")],
				beforeRestart: {
					command: "node",
					args: [join(FIXTURES, "generate-hook.js")],
				},
			},
		];
		await expect(runManager(configs, pidfilePath)).rejects.toThrow(
			/sets "beforeRestart" but no "watch" paths/,
		);
	});

	it("runs the hook only after the old process is confirmed dead, before a fresh one starts", async () => {
		const watchFile = join(tmpDir, "watch.trigger");
		writeFileSync(watchFile, "0");
		const oldPidFile = join(tmpDir, "old-pid");
		const markerFile = join(tmpDir, "generated.log");

		const configs = [
			{
				...watchedConfig("api", watchFile),
				beforeRestart: {
					command: "node",
					args: [
						join(FIXTURES, "assert-pid-dead-then-mark.js"),
						oldPidFile,
						markerFile,
					],
				},
			},
		];
		const managerPromise = runManager(configs, pidfilePath);
		const apiLog = join(tmpDir, "logs", "api.log");

		await waitFor(
			() =>
				existsSync(apiLog) && readFileSync(apiLog, "utf8").includes("started"),
		);
		const oldPid = readFileSync(apiLog, "utf8").match(/started (\d+)/)?.[1];
		expect(oldPid).toBeDefined();
		writeFileSync(oldPidFile, oldPid as string);

		await triggerWatchedRestart(watchFile);

		// The hook fixture itself exits non-zero (and never writes the marker) if it observes the
		// old pid still alive - so this only passes if the ordering is actually enforced, not just
		// eventually true.
		await waitFor(() => existsSync(markerFile), { timeoutMs: 10000 });
		await waitFor(() => {
			const matches = [
				...readFileSync(apiLog, "utf8").matchAll(/started (\d+)/g),
			];
			const newPid = matches.at(-1)?.[1];
			return newPid !== undefined && newPid !== oldPid;
		});
		expect(readFileSync(apiLog, "utf8")).toContain(
			"braid: stopping (restarting)",
		);

		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 20000);

	it("still runs onRestart after a beforeRestart-triggered respawn", async () => {
		const watchFile = join(tmpDir, "watch.trigger");
		writeFileSync(watchFile, "0");
		const beforeMarker = join(tmpDir, "before.log");
		const afterMarker = join(tmpDir, "after.log");

		const configs = [
			{
				...watchedConfig("api", watchFile),
				beforeRestart: {
					command: "node",
					args: [join(FIXTURES, "generate-hook.js"), beforeMarker],
				},
				onRestart: {
					command: "node",
					args: [join(FIXTURES, "generate-hook.js"), afterMarker],
				},
			},
		];
		const managerPromise = runManager(configs, pidfilePath);
		await waitFor(() => existsSync(pidfilePath));

		await triggerWatchedRestart(watchFile);

		await waitFor(() => existsSync(beforeMarker));
		await waitFor(() => existsSync(afterMarker), { timeoutMs: 10000 });

		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 20000);

	it("leaves the process stopped on a failing hook, but retries on the next matching change", async () => {
		const watchFile = join(tmpDir, "watch.trigger");
		writeFileSync(watchFile, "0");
		const counterPath = join(tmpDir, "counter");
		const markerPath = join(tmpDir, "generated.log");

		const configs = [
			{
				...watchedConfig("api", watchFile),
				beforeRestart: {
					command: "node",
					args: [join(FIXTURES, "flaky-hook.js"), counterPath, markerPath, "1"],
					retries: 0,
					retryDelayMs: 20,
				},
			},
		];
		const managerPromise = runManager(configs, pidfilePath);
		await waitFor(() => existsSync(pidfilePath));

		await triggerWatchedRestart(watchFile);

		const apiLog = join(tmpDir, "logs", "api.log");
		await waitFor(() =>
			readFileSync(apiLog, "utf8").includes(
				'[api] braid: beforeRestart hook "node" kept failing',
			),
		);
		expect(existsSync(markerPath)).toBe(false);

		// A subsequent matching change retries the whole cycle - flaky-hook.js succeeds this time.
		writeFileSync(watchFile, String(Date.now() + 1));
		await waitFor(() => existsSync(markerPath), { timeoutMs: 10000 });

		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 20000);

	it("ignores changes under a watched path's node_modules or .git", async () => {
		const watchDir = join(tmpDir, "watched");
		mkdirSync(join(watchDir, "node_modules"), { recursive: true });
		mkdirSync(join(watchDir, ".git"), { recursive: true });

		const configs = [
			{
				name: "api",
				command: "node",
				args: [join(FIXTURES, "keep-alive.js")],
				watch: [watchDir],
				ext: "trigger",
			},
		];
		const managerPromise = runManager(configs, pidfilePath);
		const apiLog = join(tmpDir, "logs", "api.log");
		await waitFor(
			() =>
				existsSync(apiLog) && readFileSync(apiLog, "utf8").includes("started"),
		);

		await new Promise((resolve) => setTimeout(resolve, 800));
		writeFileSync(join(watchDir, "node_modules", "dep.trigger"), "0");
		writeFileSync(join(watchDir, ".git", "HEAD.trigger"), "0");

		// No restart should happen - give it a real chance to (wrongly) fire before asserting.
		await new Promise((resolve) => setTimeout(resolve, 1000));
		expect((readFileSync(apiLog, "utf8").match(/started/g) ?? []).length).toBe(
			1,
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
