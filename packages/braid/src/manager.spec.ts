import { spawn } from "node:child_process";
import {
	chmodSync,
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
	shutdownBudgetMs,
	statusFromPidfile,
	stopFromPidfile,
} from "./manager.js";
import { sourceExecArgv } from "./module-path.js";
import type { Pidfile, ProcessConfig } from "./types.js";

// Wraps the real process-tree sampler so a test can delay its result (a slow `ps`, to land the
// restart-during-a-poll race deterministically - the sample itself still runs immediately, against
// the still-alive old pid, as it would in production), drop chosen app pids from it (an app that
// vanished between being listed and being sampled), or force a failure with a chosen rejection.
// All three are no-ops for every other test.
const statsControl = vi.hoisted(() => ({
	delayMs: 0,
	dropPids: new Set<number>(),
	forceRejectWith: undefined as unknown,
}));
vi.mock("./process-stats.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./process-stats.js")>();
	return {
		...actual,
		createTreeSampler: (
			...args: Parameters<typeof actual.createTreeSampler>
		) => {
			const sample = actual.createTreeSampler(...args);
			return async (rootPids: number[]) => {
				const pause = () =>
					new Promise((resolve) => setTimeout(resolve, statsControl.delayMs));
				if (statsControl.forceRejectWith !== undefined) {
					const rejection = statsControl.forceRejectWith;
					await pause();
					throw rejection;
				}
				const result = await sample(rootPids);
				for (const pid of statsControl.dropPids) result.delete(pid);
				await pause();
				return result;
			};
		},
	};
});

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

/** Spawns and waits out a process to get a real pid guaranteed to be dead, rather than a made-up
 *  number that could coincidentally collide with something actually running. */
async function deadPid(): Promise<number> {
	const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
	const pid = await new Promise<number>((resolve, reject) => {
		child.once("spawn", () => resolve(child.pid as number));
		child.once("error", reject);
	});
	await new Promise<void>((resolve) => child.once("exit", () => resolve()));
	return pid;
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

/**
 * `stopFromPidfile`'s own `killPid` only fires SIGTERM and resolves once the signal was *sent*,
 * not once the target has actually exited - fine for its real callers (a fresh CLI invocation
 * exiting right after), but not a strong enough guarantee for this describe block's shared
 * `afterEach`, which needs every real process a test spawned to be *confirmed* gone before the
 * next test's `beforeEach` reuses the same fixture pids/ports. A worker fork can now legitimately
 * take up to its own `stopTimeoutMs` to finish its internal SIGKILL escalation (see worker.ts's
 * SIGTERM handler) - reads the pidfile's own worker pids first (stopFromPidfile deletes the file),
 * then gives them one exponential-backoff sweep and a direct SIGKILL for anything still alive.
 * Test-hygiene-only: production shutdown has its own, more careful escalation - this is just a
 * hard backstop against a leaked real OS process outliving the test that spawned it.
 */
async function forceStopFromPidfile(pidfilePath: string): Promise<void> {
	const pidfile = existsSync(pidfilePath)
		? (JSON.parse(readFileSync(pidfilePath, "utf8")) as Pidfile)
		: undefined;
	await stopFromPidfile(pidfilePath);
	if (!pidfile) return;
	// Never this test process itself - an in-process runManager records it as the manager.
	const pids = [
		pidfile.managerPid,
		...pidfile.workers.map((w) => w.pid),
	].filter((pid) => pid !== process.pid);
	for (let delayMs = 25; delayMs <= 400; delayMs *= 2) {
		if (pids.every((pid) => !isPidAlive(pid))) return;
		await new Promise((resolve) => setTimeout(resolve, delayMs));
	}
	for (const pid of pids) {
		if (isPidAlive(pid)) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Already gone between the check above and this call - fine, that's the goal.
			}
		}
	}
}

function keepAliveConfig(name: string): ProcessConfig {
	return { name, command: "node", args: [join(FIXTURES, "keep-alive.js")] };
}

function exitFailConfig(name: string, delayMs = 0): ProcessConfig {
	return {
		name,
		command: "node",
		args: [join(FIXTURES, "exit-fail.js"), String(delayMs)],
	};
}

/** Crashes `failuresBeforeSuccess` times (tracked via `counterPath`, since each attempt is a fresh
 *  process with no shared memory), then runs like keep-alive.js forever. */
function flakyAppConfig(
	name: string,
	counterPath: string,
	failuresBeforeSuccess: number,
	overrides: Partial<ProcessConfig> = {},
): ProcessConfig {
	return {
		name,
		command: "node",
		args: [
			join(FIXTURES, "flaky-app.js"),
			counterPath,
			String(failuresBeforeSuccess),
		],
		...overrides,
	};
}

/** A process that ignores SIGTERM entirely, to exercise stopChild's SIGKILL escalation. */
function ignoreSigtermConfig(
	name: string,
	stopTimeoutMs?: number,
): ProcessConfig {
	return {
		name,
		command: "node",
		args: [join(FIXTURES, "ignore-sigterm.js")],
		...(stopTimeoutMs !== undefined ? { stopTimeoutMs } : {}),
	};
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

/** A plain (unwatched) process that prints "ready-marker <pid>" `delayMs` after it starts. */
function slowConfig(name: string, delayMs: number): ProcessConfig {
	return {
		name,
		command: "node",
		args: [join(FIXTURES, "slow-start.js"), String(delayMs)],
	};
}

/** Wraps any base config with a `startAfter` on `processes`. */
function startAfterConfig(
	base: ProcessConfig,
	processes: string[],
): ProcessConfig {
	return { ...base, startAfter: { processes } };
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

	afterEach(async () => {
		// Safety net, not the primary cleanup path: every test above already stops its own daemon
		// (and any dummy pids it wrote into a pidfile-shaped file) before finishing. But a test that
		// throws first - a failed assertion, an unexpected error, vitest's own timeout - would
		// otherwise skip that and leak a real, still-running process tree. forceStopFromPidfile is a
		// no-op (returns immediately) when there's nothing left to stop, so this is safe to run
		// unconditionally on every test, not just failures.
		await forceStopFromPidfile(pidfilePath);
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

	it.skipIf(process.platform === "win32")(
		"writes the pidfile (which carries the control-server's bearer token) and its directory with owner-only permissions",
		async () => {
			// A fresh subdirectory, not tmpDir itself - mkdtempSync already creates tmpDir at 0o700
			// by its own default, which would make this pass even without manager.ts's own fix.
			const braidDir = join(tmpDir, "braid-run-dir");
			const nestedPidfilePath = join(braidDir, "run.json");
			const configs = [keepAliveConfig("one")];
			const managerPromise = runManager(configs, nestedPidfilePath);

			await waitFor(() => existsSync(nestedPidfilePath));
			expect(statSync(braidDir).mode & 0o777).toBe(0o700);
			expect(statSync(nestedPidfilePath).mode & 0o777).toBe(0o600);

			await stopFromPidfile(nestedPidfilePath);
			await managerPromise;
		},
		10000,
	);

	it("rejects options.plugins without options.configPath before spawning anything", async () => {
		const configs = [keepAliveConfig("solo")];
		await expect(
			runManager(configs, pidfilePath, { plugins: ["some-plugin"] }),
		).rejects.toThrow(
			/options\.configPath is required to resolve options\.plugins/,
		);
		expect(existsSync(pidfilePath)).toBe(false);
	});

	it("resolves a per-process cwd relative to the manager's own baseCwd", async () => {
		const workDir = join(tmpDir, "workdir");
		mkdirSync(workDir, { recursive: true });
		const configs = [
			{
				name: "solo",
				command: "node",
				args: ["-e", "console.log(process.cwd()); process.exit(0);"],
				cwd: "workdir",
			},
		];

		const exitCode = await runManager(configs, pidfilePath, { cwd: tmpDir });
		expect(exitCode).toBe(0);

		const logPath = join(tmpDir, "logs", "solo.log");
		expect(readFileSync(logPath, "utf8")).toContain(workDir);
	});

	it("prepends a timestamp to every log line when logs.timestamps is set", async () => {
		const configs = [keepAliveConfig("solo")];
		const managerPromise = runManager(configs, pidfilePath, {
			logs: { timestamps: true },
		});
		await waitFor(() => existsSync(pidfilePath));
		const logPath = join(tmpDir, "logs", "solo.log");
		await waitFor(
			() =>
				existsSync(logPath) && readFileSync(logPath, "utf8").includes("[solo]"),
		);
		expect(readFileSync(logPath, "utf8")).toMatch(
			/\d{2}:\d{2}:\d{2}\.\d{3}.*\[solo\]/,
		);

		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 10000);

	it("does not double-process shutdown when two processes crash close together", async () => {
		const configs = [exitFailConfig("bad1"), exitFailConfig("bad2")];
		const exitCode = await runManager(configs, pidfilePath);
		expect(exitCode).toBe(1);
		expect(existsSync(pidfilePath)).toBe(false);
	}, 10000);

	it("does not double-process shutdown when SIGINT arrives twice in a row (an impatient repeat Ctrl-C)", async () => {
		const configs = [keepAliveConfig("solo")];
		const managerPromise = runManager(configs, pidfilePath);
		await waitFor(() => existsSync(pidfilePath));
		await waitFor(() =>
			isPidAlive(pidfileWorker(pidfilePath, "solo")?.pid as number),
		);

		// onSignal (unlike every other shutdown() caller) has no pre-check of its own - shutdown()'s
		// own internal re-entrancy guard is what has to catch this.
		process.emit("SIGINT");
		process.emit("SIGINT");

		const exitCode = await managerPromise;
		expect(exitCode).toBe(0);
		expect(existsSync(pidfilePath)).toBe(false);
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

	it("autoRestart retries a crashing process without killing its siblings, and manager.ts needs no special-casing to let it - a restart message is a restart message regardless of what triggered it", async () => {
		const counterPath = join(tmpDir, "counter");
		const configs = [
			keepAliveConfig("ok"),
			flakyAppConfig("flaky", counterPath, 2, {
				autoRestart: true,
				restartDelayMs: 20,
				maxRestarts: 5,
			}),
		];
		const managerPromise = runManager(configs, pidfilePath);
		await waitFor(() => existsSync(pidfilePath));

		const flakyLog = join(tmpDir, "logs", "flaky.log");
		// Recovers after its 2 configured failures, all without ever taking "ok" down - unlike
		// exitFailConfig above, this never reaches shutdown() at all. Each crash-retry sends the
		// same "restart" message a watch-triggered restart does, which core-plugins/logger.ts
		// already rotates the log on (processRestart -> rotateNow) - so by the time this resolves,
		// only the latest ("started") line is still in flaky.log itself; the crash lines this
		// implies happened are covered directly by worker.spec.ts's fake-timer unit tests instead
		// of re-asserted here against a file whose exact rotation history is an implementation
		// detail this test shouldn't depend on.
		await waitFor(
			() =>
				existsSync(flakyLog) &&
				readFileSync(flakyLog, "utf8").includes("started "),
			{ timeoutMs: 10000 },
		);
		expect(existsSync(pidfilePath)).toBe(true);
		expect(pidfileWorker(pidfilePath, "ok")).toBeDefined();

		await stopFromPidfile(pidfilePath);
		const exitCode = await managerPromise;
		expect(exitCode).toBe(0);
	}, 20000);

	it("escalates to SIGKILL, instead of hanging forever, when a process ignores SIGTERM", async () => {
		const configs = [
			ignoreSigtermConfig("stubborn", 200),
			// Delayed, not immediate: "bad" crashing kicks off the shutdown cascade that sends
			// "stubborn" its SIGTERM, and ignore-sigterm.js's own SIGTERM-ignoring handler is only
			// its *second* line - an immediate crash raced that registration closely enough (both
			// are a fresh `node` process's own startup cost) that "stubborn" sometimes received
			// SIGTERM before it had ignored anything, dying immediately by default disposition
			// instead of ever exercising the escalation this test means to cover. A head start
			// removes the race rather than papering over it with longer timeouts.
			exitFailConfig("bad", 500),
		];

		const managerPromise = runManager(configs, pidfilePath);
		await waitFor(() => existsSync(pidfilePath));
		const stubbornPid = pidfileWorker(pidfilePath, "stubborn")?.pid;
		if (stubbornPid === undefined) throw new Error("stubborn never started");
		await waitFor(() => isPidAlive(stubbornPid));

		// stubbornPid (from the pidfile) is the outer worker fork's own pid, not the inner
		// ignore-sigterm.js app's - the fork has no SIGTERM handler of its own and always dies
		// near-instantly regardless of what its inner app does, so asserting only on stubbornPid
		// can't actually detect whether the inner app was ever escalated against (a real bug this
		// test used to miss entirely - see worker.ts's own SIGTERM handler). Parse the inner app's
		// own pid from its "started <pid>" log line instead, the same way it announces itself.
		const stubbornLog = join(tmpDir, "logs", "stubborn.log");
		await waitFor(
			() =>
				existsSync(stubbornLog) &&
				/started \d+/.test(readFileSync(stubbornLog, "utf8")),
		);
		const innerPidMatch = readFileSync(stubbornLog, "utf8").match(
			/started (\d+)/,
		);
		if (!innerPidMatch)
			throw new Error("stubborn's own started <pid> line never appeared");
		const innerPid = Number(innerPidMatch[1]);
		await waitFor(() => isPidAlive(innerPid));

		// If stopChild had no SIGKILL escalation, "bad" crashing would leave shutdown() awaiting
		// "stubborn"'s exit forever - this whole test's own timeout (below) is the real assertion
		// that it doesn't hang; stopTimeoutMs: 200 above just keeps that bounded and fast.
		const exitCode = await managerPromise;

		expect(exitCode).toBe(1);
		expect(isPidAlive(stubbornPid)).toBe(false);
		expect(isPidAlive(innerPid)).toBe(false);
	}, 15000);

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

	it("rejects an invalid readyPattern regex at startup instead of crashing later", async () => {
		const configs = [{ ...keepAliveConfig("api"), readyPattern: "(" }];

		await expect(runManager(configs, pidfilePath)).rejects.toThrow(
			/"api" has an invalid readyPattern/,
		);
		expect(existsSync(pidfilePath)).toBe(false);
	});

	it("rejects two processes sharing the same name at startup, instead of one silently orphaning the other", async () => {
		const configs = [keepAliveConfig("worker"), keepAliveConfig("worker")];

		await expect(runManager(configs, pidfilePath)).rejects.toThrow(
			/duplicate process name "worker"/,
		);
		expect(existsSync(pidfilePath)).toBe(false);
	});
});

describe("runManager watch", () => {
	let tmpDir: string;
	let pidfilePath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "braid-watch-test-"));
		pidfilePath = join(tmpDir, "run.json");
	});

	afterEach(async () => {
		// Safety net, not the primary cleanup path: every test above already stops its own daemon
		// (and any dummy pids it wrote into a pidfile-shaped file) before finishing. But a test that
		// throws first - a failed assertion, an unexpected error, vitest's own timeout - would
		// otherwise skip that and leak a real, still-running process tree. forceStopFromPidfile is a
		// no-op (returns immediately) when there's nothing left to stop, so this is safe to run
		// unconditionally on every test, not just failures.
		await forceStopFromPidfile(pidfilePath);
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

	it("ignores changes inside an excluded path, but still restarts on changes elsewhere in the watched directory", async () => {
		const watchedDir = join(tmpDir, "watched");
		const excludedDir = join(watchedDir, "__generated__");
		mkdirSync(excludedDir, { recursive: true });
		const configs = [
			{
				name: "api",
				command: "node",
				args: [join(FIXTURES, "keep-alive.js")],
				watch: [watchedDir],
				ext: "txt",
				exclude: [excludedDir],
			},
		];
		const managerPromise = runManager(configs, pidfilePath);
		const logPath = join(tmpDir, "logs", "api.log");

		// The pidfile only tracks the outer worker's own pid, which never changes on a
		// watch-triggered restart (only the inner spawned app does) - the log's own "started <pid>"
		// line (see keep-alive.js) is what actually proves a restart happened, same technique the
		// sibling test above uses.
		await waitFor(
			() =>
				existsSync(logPath) &&
				readFileSync(logPath, "utf8").includes("started"),
		);
		const originalContent = readFileSync(logPath, "utf8");
		const originalPid = originalContent.match(/started (\d+)/)?.[1];
		expect(originalPid).toBeDefined();

		// Same settle delay as triggerWatchedRestart - give chokidar a moment to actually be
		// watching before writing, so this isn't a false negative from writing too early.
		await new Promise((resolve) => setTimeout(resolve, 800));
		writeFileSync(join(excludedDir, "generated.txt"), "0");
		// No restart should happen - give it every chance to (wrongly) fire before checking.
		await new Promise((resolve) => setTimeout(resolve, 1000));
		expect(readFileSync(logPath, "utf8")).toBe(originalContent);

		writeFileSync(join(watchedDir, "real.txt"), "0");
		// A watch-triggered restart rotates the log (see the sibling test above), so the fresh
		// "started <pid>" line lands in a new current log, not appended to the old one.
		await waitFor(
			() => {
				const restartedPid = readFileSync(logPath, "utf8").match(
					/started (\d+)/,
				)?.[1];
				return restartedPid !== undefined && restartedPid !== originalPid;
			},
			{ timeoutMs: 10000 },
		);

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

	afterEach(async () => {
		// Safety net, not the primary cleanup path: every test above already stops its own daemon
		// (and any dummy pids it wrote into a pidfile-shaped file) before finishing. But a test that
		// throws first - a failed assertion, an unexpected error, vitest's own timeout - would
		// otherwise skip that and leak a real, still-running process tree. forceStopFromPidfile is a
		// no-op (returns immediately) when there's nothing left to stop, so this is safe to run
		// unconditionally on every test, not just failures.
		await forceStopFromPidfile(pidfilePath);
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

	afterEach(async () => {
		// Safety net, not the primary cleanup path: every test above already stops its own daemon
		// (and any dummy pids it wrote into a pidfile-shaped file) before finishing. But a test that
		// throws first - a failed assertion, an unexpected error, vitest's own timeout - would
		// otherwise skip that and leak a real, still-running process tree. forceStopFromPidfile is a
		// no-op (returns immediately) when there's nothing left to stop, so this is safe to run
		// unconditionally on every test, not just failures.
		await forceStopFromPidfile(pidfilePath);
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

	type StatusEntry = {
		name: string;
		pid: number;
		appPid?: number;
		alive: boolean;
		cpu?: number;
		memory?: number;
		restartCount?: number;
		url?: string;
	};

	/** Polls /api/status until `predicate` matches, returning the body that satisfied it. */
	async function waitForStatus(
		pidfile: { controlPort: number; controlToken: string },
		predicate: (body: StatusEntry[]) => boolean,
		{ timeoutMs = 4000, intervalMs = 25 } = {},
	): Promise<StatusEntry[]> {
		const start = Date.now();
		while (true) {
			const res = await fetchWithToken(pidfile, "/api/status");
			const body = (await res.json()) as StatusEntry[];
			if (predicate(body)) return body;
			if (Date.now() - start > timeoutMs) {
				throw new Error("waitForStatus: timed out");
			}
			await new Promise((resolve) => setTimeout(resolve, intervalMs));
		}
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

	it("polls cpu/memory and surfaces them on /api/status, clearing them once stopped", async () => {
		const configs = [keepAliveConfig("solo")];
		const managerPromise = runManager(configs, pidfilePath, {
			statsPollIntervalMs: 50,
		});

		await waitFor(() => existsSync(pidfilePath));
		const pidfile = JSON.parse(readFileSync(pidfilePath, "utf8"));
		await waitFor(() =>
			pidfile.workers.every((w: { pid: number }) => isPidAlive(w.pid)),
		);

		const withStats = await waitForStatus(pidfile, (body) => {
			const solo = body.find((w) => w.name === "solo");
			return (
				solo !== undefined &&
				typeof solo.cpu === "number" &&
				typeof solo.memory === "number"
			);
		});
		const solo = withStats.find((w) => w.name === "solo");
		expect(solo?.memory).toBeGreaterThan(0);

		const stopRes = await fetch(
			`http://127.0.0.1:${pidfile.controlPort}/api/processes/stop?name=solo`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${pidfile.controlToken}` },
			},
		);
		expect(stopRes.status).toBe(200);

		await waitForStatus(pidfile, (body) => {
			const stopped = body.find((w) => w.name === "solo");
			return (
				stopped !== undefined && !stopped.alive && stopped.cpu === undefined
			);
		});

		// stopFromPidfile (called in-process, as every test here does) can't tree-kill its own pid -
		// it relies on the manager's natural "every worker has exited" shutdown, which stays
		// deliberately suppressed while anything is manually-stopped (see the "manual process
		// control" describe block below). Bring "solo" back first so cleanup has a real exit
		// cascade to trigger.
		await fetch(
			`http://127.0.0.1:${pidfile.controlPort}/api/processes/restart?name=solo`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${pidfile.controlToken}` },
			},
		);
		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 10000);

	it("skips an app missing from a sample, without breaking the others", async () => {
		const configs = [keepAliveConfig("one"), keepAliveConfig("two")];
		const managerPromise = runManager(configs, pidfilePath, {
			statsPollIntervalMs: 50,
		});

		await waitFor(() => existsSync(pidfilePath));
		const pidfile = JSON.parse(readFileSync(pidfilePath, "utf8"));
		await waitFor(() =>
			pidfile.workers.every((w: { pid: number }) => isPidAlive(w.pid)),
		);
		// Its app's pid - that's what's sampled now, not braid's wrapper.
		const oneAppPid = (
			await waitForStatus(pidfile, (body) =>
				body.some((w) => w.name === "one" && typeof w.appPid === "number"),
			)
		).find((w) => w.name === "one")?.appPid as number;
		statsControl.dropPids.add(oneAppPid);

		try {
			// "two" still gets sampled normally even though "one"'s app never shows up in the sample
			// (the shape an app that exited between being listed and being sampled produces).
			const withStats = await waitForStatus(pidfile, (body) => {
				const two = body.find((w) => w.name === "two");
				return two !== undefined && typeof two.cpu === "number";
			});
			const one = withStats.find((w) => w.name === "one");
			expect(one?.cpu).toBeUndefined();
		} finally {
			statsControl.dropPids.clear();
		}

		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 10000);

	it("logs a stats polling failure only once, using String() for a non-Error rejection, until it succeeds again", async () => {
		const writeSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		const configs = [keepAliveConfig("solo")];
		const managerPromise = runManager(configs, pidfilePath, {
			statsPollIntervalMs: 30,
		});
		await waitFor(() => existsSync(pidfilePath));
		await waitFor(() =>
			isPidAlive(pidfileWorker(pidfilePath, "solo")?.pid as number),
		);

		statsControl.forceRejectWith = "a plain string rejection";
		try {
			await waitFor(() =>
				writeSpy.mock.calls.some((call) =>
					String(call[0]).includes(
						"process stats polling failed (will keep retrying): a plain string rejection",
					),
				),
			);
			// A second, third, ... failing tick must not log again while it's still failing.
			const failureLogCount = () =>
				writeSpy.mock.calls.filter((call) =>
					String(call[0]).includes("process stats polling failed"),
				).length;
			await new Promise((resolve) => setTimeout(resolve, 150));
			expect(failureLogCount()).toBe(1);
		} finally {
			statsControl.forceRejectWith = undefined;
			writeSpy.mockRestore();
		}

		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 10000);

	it("logs a real Error's own message on a stats polling failure", async () => {
		const writeSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		const configs = [keepAliveConfig("solo")];
		const managerPromise = runManager(configs, pidfilePath, {
			statsPollIntervalMs: 30,
		});
		await waitFor(() => existsSync(pidfilePath));
		await waitFor(() =>
			isPidAlive(pidfileWorker(pidfilePath, "solo")?.pid as number),
		);

		// Forced deterministically - the natural version (`ps` itself failing) can't be triggered
		// on demand.
		statsControl.forceRejectWith = new Error("boom from ps");
		try {
			await waitFor(() =>
				writeSpy.mock.calls.some((call) =>
					String(call[0]).includes(
						"process stats polling failed (will keep retrying): boom from ps",
					),
				),
			);
		} finally {
			statsControl.forceRejectWith = undefined;
			writeSpy.mockRestore();
		}

		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 10000);

	it("doesn't leak a restarted process's old cpu/memory onto its new pid", async () => {
		const configs = [keepAliveConfig("solo")];
		const managerPromise = runManager(configs, pidfilePath, {
			statsPollIntervalMs: 50,
		});

		await waitFor(() => existsSync(pidfilePath));
		const pidfile = JSON.parse(readFileSync(pidfilePath, "utf8"));
		await waitFor(() =>
			pidfile.workers.every((w: { pid: number }) => isPidAlive(w.pid)),
		);

		const beforeRestart = await waitForStatus(pidfile, (body) => {
			const solo = body.find((w) => w.name === "solo");
			return solo !== undefined && typeof solo.cpu === "number";
		});
		const oldPid = beforeRestart.find((w) => w.name === "solo")?.pid;

		const restartRes = await fetch(
			`http://127.0.0.1:${pidfile.controlPort}/api/processes/restart?name=solo`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${pidfile.controlToken}` },
			},
		);
		expect(restartRes.status).toBe(200);

		// The fix under test: spawnWorker clears this name's cached stats the moment it assigns the
		// new pid, so the row right after a restart resolves must show no stats yet - never the
		// predecessor's - until a fresh poll tick actually samples the new pid.
		const rightAfterRestart = await fetchWithToken(pidfile, "/api/status");
		const soloRightAfter = (
			(await rightAfterRestart.json()) as StatusEntry[]
		).find((w) => w.name === "solo");
		expect(soloRightAfter?.pid).not.toBe(oldPid);
		expect(soloRightAfter?.cpu).toBeUndefined();
		expect(soloRightAfter?.memory).toBeUndefined();

		await waitForStatus(pidfile, (body) => {
			const solo = body.find((w) => w.name === "solo");
			return solo !== undefined && typeof solo.cpu === "number";
		});

		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 10000);

	it("starts a freshly-spawned process's restartCount at 0, and increments it once per completed restart", async () => {
		const configs = [keepAliveConfig("solo")];
		const managerPromise = runManager(configs, pidfilePath);

		await waitFor(() => existsSync(pidfilePath));
		const pidfile = JSON.parse(readFileSync(pidfilePath, "utf8"));
		await waitFor(() =>
			pidfile.workers.every((w: { pid: number }) => isPidAlive(w.pid)),
		);

		// A first spawn is not a restart - the counter starts at 0, not 1.
		const beforeRestart = (
			(await (
				await fetchWithToken(pidfile, "/api/status")
			).json()) as StatusEntry[]
		).find((w) => w.name === "solo");
		expect(beforeRestart?.restartCount).toBe(0);

		for (let i = 1; i <= 2; i++) {
			const restartRes = await fetch(
				`http://127.0.0.1:${pidfile.controlPort}/api/processes/restart?name=solo`,
				{
					method: "POST",
					headers: { Authorization: `Bearer ${pidfile.controlToken}` },
				},
			);
			expect(restartRes.status).toBe(200);
			await waitForStatus(pidfile, (body) => {
				const solo = body.find((w) => w.name === "solo");
				return solo !== undefined && solo.restartCount === i;
			});
		}

		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 10000);

	it("surfaces a configured process's own url over /api/status, omitting the field entirely when unset, for both a started and a never-started process", async () => {
		const configs = [
			{ ...keepAliveConfig("solo"), url: "http://localhost:4000" },
			keepAliveConfig("bare"),
			{
				...keepAliveConfig("idle"),
				autoStart: false,
				url: "http://localhost:5000",
			},
		];
		const managerPromise = runManager(configs, pidfilePath);

		await waitFor(() => existsSync(pidfilePath));
		const pidfile = JSON.parse(readFileSync(pidfilePath, "utf8"));
		await waitFor(() =>
			["solo", "bare"].every((name) => {
				const worker = pidfile.workers.find(
					(w: { name: string }) => w.name === name,
				);
				return worker !== undefined && isPidAlive(worker.pid);
			}),
		);

		const status = (await (
			await fetchWithToken(pidfile, "/api/status")
		).json()) as StatusEntry[];
		expect(status.find((w) => w.name === "solo")?.url).toBe(
			"http://localhost:4000",
		);
		expect(status.find((w) => w.name === "bare")?.url).toBeUndefined();
		expect(status.find((w) => w.name === "idle")?.url).toBe(
			"http://localhost:5000",
		);

		// See the identical situation/comment on "passes onReady the same snapshot..." above: a
		// never-started autoStart:false process keeps the daemon from shutting down on its own, so
		// it's started first to let a clean exit cascade trigger.
		await fetch(
			`http://127.0.0.1:${pidfile.controlPort}/api/processes/start?name=idle`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${pidfile.controlToken}` },
			},
		);
		await waitFor(() => {
			const started = pidfileWorker(pidfilePath, "idle");
			return started !== undefined && isPidAlive(started.pid);
		});

		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 10000);

	it("passes onReady the same snapshot /api/status would return at that moment, including a never-started process", async () => {
		const configs = [
			keepAliveConfig("solo"),
			{ ...keepAliveConfig("idle"), autoStart: false },
		];
		let readyWorkers:
			| Array<{ name: string; alive: boolean; restartCount: number }>
			| undefined;
		const managerPromise = runManager(configs, pidfilePath, {
			onReady: (workers) => {
				readyWorkers = workers;
			},
		});

		await waitFor(() => readyWorkers !== undefined);
		const solo = readyWorkers?.find((w) => w.name === "solo");
		const idle = readyWorkers?.find((w) => w.name === "idle");
		expect(solo).toEqual(
			expect.objectContaining({ alive: true, restartCount: 0 }),
		);
		expect(idle).toEqual(
			expect.objectContaining({ alive: false, restartCount: 0 }),
		);

		// "idle" (autoStart: false, never started) has no pidfile entry for stopFromPidfile's
		// worker-killing loop to find, and the daemon deliberately never shuts down on its own while
		// it could still be started - see the identical situation/comment on the autoStart describe
		// block's "never forks an autoStart: false process at boot" test. Starting it first lets the
		// normal all-workers-exited shutdown cascade fire once stopFromPidfile runs.
		const pidfile = JSON.parse(readFileSync(pidfilePath, "utf8"));
		await fetch(
			`http://127.0.0.1:${pidfile.controlPort}/api/processes/start?name=idle`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${pidfile.controlToken}` },
			},
		);
		await waitFor(() => {
			const started = pidfileWorker(pidfilePath, "idle");
			return started !== undefined && isPidAlive(started.pid);
		});

		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 10000);

	it("doesn't leak a restarted process's old cpu/memory when a poll's sample is still in flight at the moment of the restart", async () => {
		const configs = [keepAliveConfig("solo")];
		const managerPromise = runManager(configs, pidfilePath, {
			statsPollIntervalMs: 50,
		});

		try {
			await waitFor(() => existsSync(pidfilePath));
			const pidfile = JSON.parse(readFileSync(pidfilePath, "utf8"));
			await waitFor(() =>
				pidfile.workers.every((w: { pid: number }) => isPidAlive(w.pid)),
			);

			// Confirm normal polling works before introducing any artificial delay.
			await waitForStatus(pidfile, (body) => {
				const solo = body.find((w) => w.name === "solo");
				return solo !== undefined && typeof solo.cpu === "number";
			});

			// Slow every subsequent sample down (simulating a slow `ps`)
			// - long enough that a restart can land, and this test observe the moment, while a
			// poll tick sampling the *old* pid is still in flight.
			statsControl.delayMs = 500;
			await new Promise((resolve) => setTimeout(resolve, 70));
			const oldPid = pidfileWorker(pidfilePath, "solo")?.pid;

			const restartRes = await fetch(
				`http://127.0.0.1:${pidfile.controlPort}/api/processes/restart?name=solo`,
				{
					method: "POST",
					headers: { Authorization: `Bearer ${pidfile.controlToken}` },
				},
			);
			expect(restartRes.status).toBe(200);
			const newPid = pidfileWorker(pidfilePath, "solo")?.pid;
			expect(newPid).not.toBe(oldPid);

			// Wait past the in-flight poll's artificial delay, so its (stale, old-pid) sample
			// resolves now - the fix under test: it must not write its result back onto
			// "solo" once the current pid no longer matches the one it actually sampled.
			await new Promise((resolve) => setTimeout(resolve, 500));
			statsControl.delayMs = 0;

			const afterStalePoll = await fetchWithToken(pidfile, "/api/status");
			const soloAfterStalePoll = (
				(await afterStalePoll.json()) as StatusEntry[]
			).find((w) => w.name === "solo");
			expect(soloAfterStalePoll?.pid).toBe(newPid);
			expect(soloAfterStalePoll?.cpu).toBeUndefined();
			expect(soloAfterStalePoll?.memory).toBeUndefined();

			// Normal polling resumes and correctly samples the new pid.
			await waitForStatus(pidfile, (body) => {
				const solo = body.find((w) => w.name === "solo");
				return (
					solo !== undefined &&
					solo.pid === newPid &&
					typeof solo.cpu === "number"
				);
			});
		} finally {
			statsControl.delayMs = 0;
			await stopFromPidfile(pidfilePath);
			await managerPromise;
		}
	}, 15000);

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

	afterEach(async () => {
		// Safety net, not the primary cleanup path: every test above already stops its own daemon
		// (and any dummy pids it wrote into a pidfile-shaped file) before finishing. But a test that
		// throws first - a failed assertion, an unexpected error, vitest's own timeout - would
		// otherwise skip that and leak a real, still-running process tree. forceStopFromPidfile is a
		// no-op (returns immediately) when there's nothing left to stop, so this is safe to run
		// unconditionally on every test, not just failures.
		await forceStopFromPidfile(pidfilePath);
		rmSync(tmpDir, { recursive: true, force: true });
	});

	async function postAction(
		pidfile: { controlPort: number; controlToken: string },
		action: "stop" | "restart" | "start",
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

	it("returns 404 for stopping a one-shot process that already exited on its own (not manually stopped)", async () => {
		const configs = [
			keepAliveConfig("solo"),
			{ name: "oneshot", command: "node", args: ["-e", "process.exit(0)"] },
		];
		const managerPromise = runManager(configs, pidfilePath);
		await waitFor(() => existsSync(pidfilePath));
		const pidfile = JSON.parse(readFileSync(pidfilePath, "utf8"));
		await waitFor(() => {
			const oneshot = pidfileWorker(pidfilePath, "oneshot");
			return oneshot !== undefined && !isPidAlive(oneshot.pid);
		});

		expect((await postAction(pidfile, "stop", "oneshot")).status).toBe(404);

		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 10000);

	it("returns 409 busy when stopping a process while its own onRestart hook is still in progress", async () => {
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

		const restart = postAction(pidfile, "restart", "api");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect((await postAction(pidfile, "stop", "api")).status).toBe(409);
		expect((await restart).status).toBe(200);

		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 10000);

	it("start on a previously-run, now-stopped process delegates to restart (a fresh pid, not a no-op)", async () => {
		const configs = [keepAliveConfig("solo")];
		const managerPromise = runManager(configs, pidfilePath);
		await waitFor(() => existsSync(pidfilePath));
		await waitFor(() =>
			isPidAlive(pidfileWorker(pidfilePath, "solo")?.pid as number),
		);
		const pidfile = JSON.parse(readFileSync(pidfilePath, "utf8"));

		expect((await postAction(pidfile, "stop", "solo")).status).toBe(200);
		await waitFor(
			() => !isPidAlive(pidfileWorker(pidfilePath, "solo")?.pid as number),
		);

		expect((await postAction(pidfile, "start", "solo")).status).toBe(200);
		await waitFor(() =>
			isPidAlive(pidfileWorker(pidfilePath, "solo")?.pid as number),
		);

		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 10000);

	it("skips a watch-triggered restart's own handleFreshStart while a manual restart already holds the lock for the same process", async () => {
		const watchFile = join(tmpDir, "watch.trigger");
		writeFileSync(watchFile, "0");
		const configs = [
			{
				...watchedConfig("target", watchFile),
				onRestart: {
					command: "node",
					args: [join(FIXTURES, "slow-hook.js"), "2500"],
				},
			},
		];
		const managerPromise = runManager(configs, pidfilePath);
		await waitFor(() => existsSync(pidfilePath));
		await waitFor(() =>
			isPidAlive(pidfileWorker(pidfilePath, "target")?.pid as number),
		);
		const pidfile = JSON.parse(readFileSync(pidfilePath, "utf8"));

		// The manual restart respawns "target" (a brand new worker + its own fresh watcher) almost
		// immediately, then holds the `restarting` lock for ~2500ms while its own onRestart hook
		// runs. triggerWatchedRestart's own 800ms settle wait comfortably lands inside that window,
		// so the fresh worker's *own* watch-triggered restart cycle - and the "started" message it
		// sends once done - arrives while the manual restart above still holds the lock.
		const manualRestart = postAction(pidfile, "restart", "target");
		await triggerWatchedRestart(watchFile);

		expect((await manualRestart).status).toBe(200);

		// The watch-triggered respawn still genuinely happens - the worker itself doesn't know or
		// care about the manager's own lock - just without a second, overlapping handleFreshStart
		// call for it while the manual restart's own hook-phase lock is still held.
		await waitFor(
			() => isPidAlive(pidfileWorker(pidfilePath, "target")?.pid as number),
			{ timeoutMs: 10000 },
		);

		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 15000);

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

	afterEach(async () => {
		// Safety net, not the primary cleanup path: every test above already stops its own daemon
		// (and any dummy pids it wrote into a pidfile-shaped file) before finishing. But a test that
		// throws first - a failed assertion, an unexpected error, vitest's own timeout - would
		// otherwise skip that and leak a real, still-running process tree. forceStopFromPidfile is a
		// no-op (returns immediately) when there's nothing left to stop, so this is safe to run
		// unconditionally on every test, not just failures.
		await forceStopFromPidfile(pidfilePath);
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

	it("does not force-spawn (or leak a duplicate of) a dependent still waiting on its own startAfter chain when its dependency restarts", async () => {
		const watchFile = join(tmpDir, "watch.trigger");
		writeFileSync(watchFile, "0");

		const configs = [
			watchedConfig("api", watchFile),
			startAfterConfig(dependentConfig("client", ["api"]), ["slow-dep"]),
			{ ...slowConfig("slow-dep", 1500), readyPattern: "ready-marker" },
		];
		const managerPromise = runManager(configs, pidfilePath);
		await waitFor(() => existsSync(pidfilePath));

		// "client" hasn't spawned yet - still waiting on "slow-dep"'s own readyPattern.
		expect(pidfileWorker(pidfilePath, "client")).toBeUndefined();

		// "api" restarts while "client" is still pending its own first spawn - restartDependent must
		// not force-start it early: that would jump ahead of its own startAfter wait, and - since
		// ensureReady would still spawn it again once slow-dep is actually ready - leak the first,
		// now-untracked process (reproduced directly before this fix: the orphaned process was never
		// killed even on daemon shutdown, since nothing kept a reference to it once `children` was
		// overwritten by the second spawn).
		await triggerWatchedRestart(watchFile);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(pidfileWorker(pidfilePath, "client")).toBeUndefined();

		await waitFor(
			() => {
				const client = pidfileWorker(pidfilePath, "client");
				return client !== undefined && isPidAlive(client.pid);
			},
			{ timeoutMs: 15000 },
		);
		const clientPid = pidfileWorker(pidfilePath, "client")?.pid;

		// Settles on exactly one spawn - no second, later respawn replacing this one's pid.
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(pidfileWorker(pidfilePath, "client")?.pid).toBe(clientPid);

		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 20000);

	it("resolves a dependsOn.run hook's own cwd relative to the manager's baseCwd", async () => {
		const workDir = join(tmpDir, "workdir");
		mkdirSync(workDir, { recursive: true });
		const watchFile = join(tmpDir, "watch.trigger");
		writeFileSync(watchFile, "0");

		const configs = [
			watchedConfig("api", watchFile),
			dependentConfig("client", ["api"], {
				command: "node",
				args: ["-e", "console.log(process.cwd())"],
				cwd: "workdir",
			}),
		];
		const managerPromise = runManager(configs, pidfilePath, { cwd: tmpDir });
		await waitFor(() => existsSync(pidfilePath));
		await waitFor(() => {
			const client = pidfileWorker(pidfilePath, "client");
			return client !== undefined && isPidAlive(client.pid);
		});

		await triggerWatchedRestart(watchFile);

		const clientLog = join(tmpDir, "logs", "client.log");
		// Bumped from 10000/20000 - this test flaked on CI's shared/loaded runners with no source
		// regression (confirmed via debug instrumentation: the hook's cwd resolves correctly and the
		// full started->stopping->cwd->started sequence appears in well under 2s once the system
		// isn't under load - see the identical, already-documented class of flake on the
		// readyPattern describe block's "holds off a dependent's restart..." test, which needed its
		// own margins widened more than once). Real subprocess spawn/watch-settle overhead just has
		// less slack here than on a typical dev machine.
		await waitFor(
			() =>
				existsSync(clientLog) &&
				readFileSync(clientLog, "utf8").includes(workDir),
			{
				timeoutMs: 20000,
			},
		);

		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 30000);

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

	it("waits for a dependency-cascaded restart's own onRestart hook before cascading further (multi-hop chain)", async () => {
		const watchFile = join(tmpDir, "watch.trigger");
		writeFileSync(watchFile, "0");

		// grandchild depends on client, which itself depends on api - and, critically, client also
		// has its own onRestart hook. Before the fix, restartDependent (used for the api->client leg)
		// skipped straight to notifying grandchild the instant client respawned, without ever running
		// client's own onRestart hook first - unlike a direct restart of client, which does.
		const configs = [
			watchedConfig("api", watchFile),
			{
				...keepAliveConfig("client"),
				dependsOn: { processes: ["api"] },
				onRestart: {
					command: "node",
					args: [join(FIXTURES, "slow-hook.js"), "400"],
				},
			},
			dependentConfig("grandchild", ["client"]),
		];
		const managerPromise = runManager(configs, pidfilePath);

		await waitFor(() => existsSync(pidfilePath));
		await waitFor(() => pidfileWorker(pidfilePath, "grandchild") !== undefined);
		const clientBefore = pidfileWorker(pidfilePath, "client");
		const grandchildBefore = pidfileWorker(pidfilePath, "grandchild");

		await triggerWatchedRestart(watchFile);

		await waitFor(
			() => {
				const client = pidfileWorker(pidfilePath, "client");
				return client !== undefined && client.pid !== clientBefore?.pid;
			},
			{ timeoutMs: 10000 },
		);

		// client has respawned, but its 400ms onRestart hook should still be running - grandchild
		// must not have cascaded yet.
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(pidfileWorker(pidfilePath, "grandchild")?.pid).toBe(
			grandchildBefore?.pid,
		);

		await waitFor(
			() => {
				const grandchild = pidfileWorker(pidfilePath, "grandchild");
				return (
					grandchild !== undefined && grandchild.pid !== grandchildBefore?.pid
				);
			},
			{ timeoutMs: 10000 },
		);
		const clientLog = join(tmpDir, "logs", "client.log");
		expect(readFileSync(clientLog, "utf8")).toContain("slow-hook ran");

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

	it("stops retrying a dependsOn hook once a real shutdown begins mid-retry-delay, instead of hanging or finishing the count", async () => {
		const watchFile = join(tmpDir, "watch.trigger");
		writeFileSync(watchFile, "0");

		const configs = [
			watchedConfig("api", watchFile),
			dependentConfig("client", ["api"], {
				command: "node",
				args: [join(FIXTURES, "always-fail-hook.js")],
				// Chosen so 10 retries * 3000ms (30s+) is far longer than this test's own timeout -
				// the manager exiting well within that proves the retry loop's own `shuttingDown`
				// check (not the natural retry count) is what cut it short.
				retries: 10,
				retryDelayMs: 3000,
			}),
			// Crashes ~1.5s after start - timed to land while the hook above is sitting in its first
			// retryDelayMs wait (triggered ~800ms in by triggerWatchedRestart, failing near-instantly).
			{
				name: "bad",
				command: "node",
				args: ["-e", "setTimeout(() => process.exit(1), 1500)"],
			},
		];
		const managerPromise = runManager(configs, pidfilePath);

		await waitFor(() => existsSync(pidfilePath));
		await waitFor(() => {
			const client = pidfileWorker(pidfilePath, "client");
			return client !== undefined && isPidAlive(client.pid);
		});

		await triggerWatchedRestart(watchFile);

		const exitCode = await managerPromise;
		expect(exitCode).toBe(1);
		expect(existsSync(pidfilePath)).toBe(false);
	}, 12000);

	it("tree-kills an in-flight dependsOn hook process itself when a real shutdown begins while it's still running", async () => {
		const watchFile = join(tmpDir, "watch.trigger");
		writeFileSync(watchFile, "0");

		const configs = [
			watchedConfig("api", watchFile),
			dependentConfig("client", ["api"], {
				command: "node",
				args: [join(FIXTURES, "slow-hook.js"), "3000"],
			}),
			// Crashes while the hook above is still actually running (not merely retry-delaying).
			{
				name: "bad",
				command: "node",
				args: ["-e", "setTimeout(() => process.exit(1), 1500)"],
			},
		];
		const managerPromise = runManager(configs, pidfilePath);

		await waitFor(() => existsSync(pidfilePath));
		await waitFor(() => {
			const client = pidfileWorker(pidfilePath, "client");
			return client !== undefined && isPidAlive(client.pid);
		});

		await triggerWatchedRestart(watchFile);

		const exitCode = await managerPromise;
		expect(exitCode).toBe(1);
		expect(existsSync(pidfilePath)).toBe(false);
	}, 10000);
});

describe("runManager onRestart", () => {
	let tmpDir: string;
	let pidfilePath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "braid-onrestart-test-"));
		pidfilePath = join(tmpDir, "run.json");
	});

	afterEach(async () => {
		// Safety net, not the primary cleanup path: every test above already stops its own daemon
		// (and any dummy pids it wrote into a pidfile-shaped file) before finishing. But a test that
		// throws first - a failed assertion, an unexpected error, vitest's own timeout - would
		// otherwise skip that and leak a real, still-running process tree. forceStopFromPidfile is a
		// no-op (returns immediately) when there's nothing left to stop, so this is safe to run
		// unconditionally on every test, not just failures.
		await forceStopFromPidfile(pidfilePath);
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

	afterEach(async () => {
		// Safety net, not the primary cleanup path: every test above already stops its own daemon
		// (and any dummy pids it wrote into a pidfile-shaped file) before finishing. But a test that
		// throws first - a failed assertion, an unexpected error, vitest's own timeout - would
		// otherwise skip that and leak a real, still-running process tree. forceStopFromPidfile is a
		// no-op (returns immediately) when there's nothing left to stop, so this is safe to run
		// unconditionally on every test, not just failures.
		await forceStopFromPidfile(pidfilePath);
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
		// with less slack on a loaded CI runner even at the same outer test timeout. Bumped a
		// second time (20000 -> 45000) after it still hit its previous 20s/30s cap on CI - this
		// file now spawns a lot more child processes overall (the manual stop/restart tests added
		// alongside it), so a shared runner has even less headroom than when that cap was last
		// raised.
		await waitFor(() => existsSync(markerFile), { timeoutMs: 45000 });

		// Some slack for scheduling jitter, but this proves the hook waited for readiness rather
		// than firing the moment "api" merely decided to restart.
		expect(Date.now() - triggeredAt).toBeGreaterThanOrEqual(readyDelayMs - 300);

		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 60000);

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

	it("ignores processOutput events from unrelated processes while waiting for a readyPattern match", async () => {
		const watchFile = join(tmpDir, "watch.trigger");
		writeFileSync(watchFile, "0");
		const readyDelayMs = 1000;

		const configs = [
			{
				...watchedSlowConfig("api", watchFile, readyDelayMs),
				readyPattern: "ready-marker",
			},
			// Restarts on the very same trigger, interleaving its own unrelated processOutput events
			// on the shared emitter while "api"'s own readyPattern wait is in progress.
			watchedConfig("noise", watchFile),
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
			() => {
				const client = pidfileWorker(pidfilePath, "client");
				return (
					client !== undefined &&
					client.pid !== clientBefore?.pid &&
					isPidAlive(client.pid)
				);
			},
			{ timeoutMs: 15000 },
		);

		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 20000);

	it("ignores a late readyPattern match that arrives after readyTimeoutMs already gave up", async () => {
		const watchFile = join(tmpDir, "watch.trigger");
		writeFileSync(watchFile, "0");
		const configs = [
			{
				// Prints "ready-marker" 800ms after each restart - well after the 200ms timeout below
				// already gives up, so the match arrives at a `settle()` call that's already a no-op.
				...watchedSlowConfig("api", watchFile, 800),
				readyPattern: "ready-marker",
				readyTimeoutMs: 200,
			},
			dependentConfig("client", ["api"]),
		];
		const writeSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		const managerPromise = runManager(configs, pidfilePath);
		await waitFor(() => existsSync(pidfilePath));
		await waitFor(() => {
			const client = pidfileWorker(pidfilePath, "client");
			return client !== undefined && isPidAlive(client.pid);
		});
		const clientBefore = pidfileWorker(pidfilePath, "client");

		await triggerWatchedRestart(watchFile);

		await waitFor(() =>
			writeSpy.mock.calls.some((call) =>
				String(call[0]).includes(
					'"api": readyPattern never matched within 200ms',
				),
			),
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
		// Gives the late marker (arriving ~600ms after the timeout already fired) time to actually
		// reach the emitter - the real assertion is simply that nothing throws/hangs as a result,
		// proving the (by-then-unregistered) output listener isn't left in a state that misbehaves
		// once the process it was watching produces the very output it was originally waiting for.
		await new Promise((resolve) => setTimeout(resolve, 900));

		writeSpy.mockRestore();
		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 20000);

	it("skips the onRestart hook if shutdown begins during a slow readyPattern wait", async () => {
		const watchFile = join(tmpDir, "watch.trigger");
		writeFileSync(watchFile, "0");
		const markerFile = join(tmpDir, "generated.log");

		const configs = [
			{
				// The marker only appears 3s after restart - readyTimeoutMs (5s) leaves plenty of room
				// for "bad" (below) to crash the whole stack while this wait is still in progress.
				...watchedSlowConfig("api", watchFile, 3000),
				readyPattern: "ready-marker",
				readyTimeoutMs: 5000,
				onRestart: {
					command: "node",
					args: [join(FIXTURES, "generate-hook.js"), markerFile],
				},
			},
			{
				name: "bad",
				command: "node",
				args: ["-e", "setTimeout(() => process.exit(1), 1500)"],
			},
		];
		const managerPromise = runManager(configs, pidfilePath);
		await waitFor(() => existsSync(pidfilePath));
		await waitFor(() =>
			isPidAlive(pidfileWorker(pidfilePath, "api")?.pid as number),
		);

		await triggerWatchedRestart(watchFile);

		const exitCode = await managerPromise;
		expect(exitCode).toBe(1);
		// handleFreshStart's own post-readyPattern-wait shuttingDown check must have caught this -
		// the onRestart hook (which would have created markerFile) never got to run.
		expect(existsSync(markerFile)).toBe(false);
	}, 10000);
});

describe("runManager startAfter", () => {
	let tmpDir: string;
	let pidfilePath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "braid-start-after-test-"));
		pidfilePath = join(tmpDir, "run.json");
	});

	afterEach(async () => {
		// Safety net, not the primary cleanup path: every test above already stops its own daemon
		// (and any dummy pids it wrote into a pidfile-shaped file) before finishing. But a test that
		// throws first - a failed assertion, an unexpected error, vitest's own timeout - would
		// otherwise skip that and leak a real, still-running process tree. forceStopFromPidfile is a
		// no-op (returns immediately) when there's nothing left to stop, so this is safe to run
		// unconditionally on every test, not just failures.
		await forceStopFromPidfile(pidfilePath);
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("rejects a circular startAfter chain before spawning anything", async () => {
		const configs = [
			startAfterConfig(keepAliveConfig("a"), ["b"]),
			startAfterConfig(keepAliveConfig("b"), ["a"]),
		];

		await expect(runManager(configs, pidfilePath)).rejects.toThrow(
			/circular startup dependency/,
		);
		expect(existsSync(pidfilePath)).toBe(false);
	});

	it("rejects a startAfter.processes entry naming an unconfigured process", async () => {
		const configs = [
			startAfterConfig(keepAliveConfig("client"), ["missing-api"]),
		];

		await expect(runManager(configs, pidfilePath)).rejects.toThrow(
			/starts after unknown process "missing-api"/,
		);
		expect(existsSync(pidfilePath)).toBe(false);
	});

	it("does not spawn a dependent until its startAfter dependency's readyPattern matches", async () => {
		const readyDelayMs = 1500;
		const configs = [
			{ ...slowConfig("api", readyDelayMs), readyPattern: "ready-marker" },
			startAfterConfig(keepAliveConfig("client"), ["api"]),
		];
		const startedAt = Date.now();
		const managerPromise = runManager(configs, pidfilePath);

		await waitFor(() => existsSync(pidfilePath));
		await waitFor(
			() => {
				const client = pidfileWorker(pidfilePath, "client");
				return client !== undefined && isPidAlive(client.pid);
			},
			{ timeoutMs: 10000 },
		);

		// Some slack for scheduling jitter, but this proves "client" waited for "api"'s own
		// readiness rather than spawning the instant "api" itself was forked.
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(readyDelayMs - 300);

		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 20000);

	it("spawns a dependent once its dependency has forked, when the dependency sets no readyPattern", async () => {
		const configs = [
			keepAliveConfig("api"),
			startAfterConfig(keepAliveConfig("client"), ["api"]),
		];
		const managerPromise = runManager(configs, pidfilePath);

		await waitFor(() => existsSync(pidfilePath));
		await waitFor(() => {
			const client = pidfileWorker(pidfilePath, "client");
			return client !== undefined && isPidAlive(client.pid);
		});

		await stopFromPidfile(pidfilePath);
		await managerPromise;
	});

	it("logs and spawns the dependent anyway once readyTimeoutMs elapses without a match", async () => {
		const writeSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		const configs = [
			{
				...keepAliveConfig("api"),
				readyPattern: "this-will-never-appear-in-output",
				readyTimeoutMs: 300,
			},
			startAfterConfig(keepAliveConfig("client"), ["api"]),
		];
		const managerPromise = runManager(configs, pidfilePath);

		await waitFor(() => existsSync(pidfilePath));
		await waitFor(
			() =>
				writeSpy.mock.calls.some((call) =>
					String(call[0]).includes(
						'"api": readyPattern never matched within 300ms; starting dependents anyway',
					),
				),
			{ timeoutMs: 10000 },
		);
		await waitFor(() => {
			const client = pidfileWorker(pidfilePath, "client");
			return client !== undefined && isPidAlive(client.pid);
		});

		writeSpy.mockRestore();
		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 20000);

	it("fires onReady promptly even with a slow startAfter chain still in flight", async () => {
		const readyDelayMs = 2000;
		const configs = [
			{ ...slowConfig("api", readyDelayMs), readyPattern: "ready-marker" },
			startAfterConfig(keepAliveConfig("client"), ["api"]),
		];
		let readyAt: number | undefined;
		const startedAt = Date.now();
		const managerPromise = runManager(configs, pidfilePath, {
			onReady: () => {
				readyAt = Date.now();
			},
		});

		await waitFor(() => readyAt !== undefined);
		expect((readyAt as number) - startedAt).toBeLessThan(readyDelayMs - 500);

		await waitFor(
			() => {
				const client = pidfileWorker(pidfilePath, "client");
				return client !== undefined && isPidAlive(client.pid);
			},
			{ timeoutMs: 10000 },
		);

		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 20000);

	it("does not shut down while a startAfter-gated process is still pending, even once an unrelated one-shot process has exited", async () => {
		const readyDelayMs = 1500;
		const configs = [
			{ name: "oneshot", command: "node", args: ["-e", "process.exit(0)"] },
			{ ...slowConfig("api", readyDelayMs), readyPattern: "ready-marker" },
			startAfterConfig(keepAliveConfig("client"), ["api"]),
		];
		const managerPromise = runManager(configs, pidfilePath);

		await waitFor(() => existsSync(pidfilePath));
		// Give the one-shot process plenty of time to have exited well before "client" spawns.
		await new Promise((resolve) => setTimeout(resolve, 500));

		await waitFor(
			() => {
				const client = pidfileWorker(pidfilePath, "client");
				return client !== undefined && isPidAlive(client.pid);
			},
			{ timeoutMs: 10000 },
		);

		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 20000);
});

describe("runManager autoStart", () => {
	let tmpDir: string;
	let pidfilePath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "braid-auto-start-test-"));
		pidfilePath = join(tmpDir, "run.json");
	});

	afterEach(async () => {
		// Safety net, not the primary cleanup path: every test above already stops its own daemon
		// (and any dummy pids it wrote into a pidfile-shaped file) before finishing. But a test that
		// throws first - a failed assertion, an unexpected error, vitest's own timeout - would
		// otherwise skip that and leak a real, still-running process tree. forceStopFromPidfile is a
		// no-op (returns immediately) when there's nothing left to stop, so this is safe to run
		// unconditionally on every test, not just failures.
		await forceStopFromPidfile(pidfilePath);
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function manualConfig(name: string): ProcessConfig {
		return { ...keepAliveConfig(name), autoStart: false };
	}

	async function postAction(
		pidfile: { controlPort: number; controlToken: string },
		action: "stop" | "restart" | "start",
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

	type StatusEntry = {
		name: string;
		pid: number | undefined;
		alive: boolean;
		startedAt?: string;
	};

	async function fetchStatus(pidfile: {
		controlPort: number;
		controlToken: string;
	}): Promise<StatusEntry[]> {
		const res = await fetch(
			`http://127.0.0.1:${pidfile.controlPort}/api/status`,
			{
				headers: { Authorization: `Bearer ${pidfile.controlToken}` },
			},
		);
		return (await res.json()) as StatusEntry[];
	}

	it("rejects autoStart: false combined with a non-empty dependsOn before spawning anything", async () => {
		const configs = [
			keepAliveConfig("api"),
			{ ...manualConfig("cron"), dependsOn: { processes: ["api"] } },
		];

		await expect(runManager(configs, pidfilePath)).rejects.toThrow(
			/"cron" has autoStart: false and also declares dependsOn/,
		);
		expect(existsSync(pidfilePath)).toBe(false);
	});

	it("rejects a startAfter target with autoStart: false before spawning anything", async () => {
		const configs = [
			manualConfig("api"),
			startAfterConfig(keepAliveConfig("client"), ["api"]),
		];

		await expect(runManager(configs, pidfilePath)).rejects.toThrow(
			/"client" starts after "api", but "api" has autoStart: false/,
		);
		expect(existsSync(pidfilePath)).toBe(false);
	});

	it("never forks an autoStart: false process at boot, but still lists it (as not-started) over /api/status", async () => {
		const configs = [keepAliveConfig("api"), manualConfig("cron")];
		const managerPromise = runManager(configs, pidfilePath);

		await waitFor(() => existsSync(pidfilePath));
		await waitFor(() => {
			const api = pidfileWorker(pidfilePath, "api");
			return api !== undefined && isPidAlive(api.pid);
		});
		// Give a never-going-to-happen spawn every chance to have happened by now.
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(pidfileWorker(pidfilePath, "cron")).toBeUndefined();

		const pidfile = JSON.parse(readFileSync(pidfilePath, "utf8"));
		const status = await fetchStatus(pidfile);
		const cron = status.find((s) => s.name === "cron");
		expect(cron).toEqual({
			name: "cron",
			pid: undefined,
			alive: false,
			restartCount: 0,
		});

		// A never-started autoStart:false process has no pidfile entry for stopFromPidfile's
		// worker-killing loop to find, and the daemon deliberately never shuts down on its own
		// while "cron" could still be started (that's what this test is proving) - so an in-process
		// test (which can't tree-kill its own pid, see other blocks' identical comment) needs to
		// bring it up first for a clean exit cascade to trigger.
		await postAction(pidfile, "start", "cron");
		await waitFor(() => {
			const started = pidfileWorker(pidfilePath, "cron");
			return started !== undefined && isPidAlive(started.pid);
		});

		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 10000);

	it("does not shut down once every auto-started process has exited, while an autoStart: false one is still unstarted", async () => {
		const configs = [
			{ name: "oneshot", command: "node", args: ["-e", "process.exit(0)"] },
			manualConfig("cron"),
		];
		const managerPromise = runManager(configs, pidfilePath);

		await waitFor(() => existsSync(pidfilePath));
		const pidfile = JSON.parse(readFileSync(pidfilePath, "utf8"));
		// Give shutdownIfEveryWorkerIsDone a moment to (wrongly) fire once "oneshot" exits, if it
		// were going to - "cron" never having forked at all must not look like "everyone's done".
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(existsSync(pidfilePath)).toBe(true);
		expect(isPidAlive(pidfile.managerPid)).toBe(true);

		expect((await postAction(pidfile, "start", "cron")).status).toBe(200);
		await waitFor(() => {
			const cron = pidfileWorker(pidfilePath, "cron");
			return cron !== undefined && isPidAlive(cron.pid);
		});

		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 10000);

	it("starts an autoStart: false process on demand via POST /api/processes/start", async () => {
		const configs = [manualConfig("cron")];
		const managerPromise = runManager(configs, pidfilePath);

		await waitFor(() => existsSync(pidfilePath));
		const pidfile = JSON.parse(readFileSync(pidfilePath, "utf8"));

		expect((await postAction(pidfile, "start", "cron")).status).toBe(200);
		await waitFor(() => {
			const cron = pidfileWorker(pidfilePath, "cron");
			return cron !== undefined && isPidAlive(cron.pid);
		});

		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 10000);

	it("is idempotent: starting an already-running process again is a no-op, not a respawn", async () => {
		const configs = [manualConfig("cron")];
		const managerPromise = runManager(configs, pidfilePath);

		await waitFor(() => existsSync(pidfilePath));
		const pidfile = JSON.parse(readFileSync(pidfilePath, "utf8"));
		await postAction(pidfile, "start", "cron");
		await waitFor(() => {
			const cron = pidfileWorker(pidfilePath, "cron");
			return cron !== undefined && isPidAlive(cron.pid);
		});
		const before = pidfileWorker(pidfilePath, "cron")?.pid;

		expect((await postAction(pidfile, "start", "cron")).status).toBe(200);
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(pidfileWorker(pidfilePath, "cron")?.pid).toBe(before);

		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 10000);

	it("returns 404 for starting an unconfigured process name", async () => {
		const configs = [keepAliveConfig("api")];
		const managerPromise = runManager(configs, pidfilePath);

		await waitFor(() => existsSync(pidfilePath));
		const pidfile = JSON.parse(readFileSync(pidfilePath, "utf8"));
		expect((await postAction(pidfile, "start", "missing")).status).toBe(404);

		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 10000);

	it("honors its own startAfter chain on a manual first start", async () => {
		const readyDelayMs = 1500;
		const configs = [
			{ ...slowConfig("api", readyDelayMs), readyPattern: "ready-marker" },
			startAfterConfig(manualConfig("cron"), ["api"]),
		];
		const managerPromise = runManager(configs, pidfilePath);

		await waitFor(() => existsSync(pidfilePath));
		const pidfile = JSON.parse(readFileSync(pidfilePath, "utf8"));
		const startedAt = Date.now();
		expect((await postAction(pidfile, "start", "cron")).status).toBe(200);

		await waitFor(
			() => {
				const cron = pidfileWorker(pidfilePath, "cron");
				return cron !== undefined && isPidAlive(cron.pid);
			},
			{ timeoutMs: 10000 },
		);
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(readyDelayMs - 300);

		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 20000);

	it("does not cascade to a dependsOn dependent on its manual first start (a first spawn is not a restart)", async () => {
		const configs = [
			manualConfig("cron"),
			dependentConfig("dependent", ["cron"]),
		];
		const managerPromise = runManager(configs, pidfilePath);

		await waitFor(() => existsSync(pidfilePath));
		await waitFor(() => {
			const dependent = pidfileWorker(pidfilePath, "dependent");
			return dependent !== undefined && isPidAlive(dependent.pid);
		});
		const dependentBefore = pidfileWorker(pidfilePath, "dependent")?.pid;
		const pidfile = JSON.parse(readFileSync(pidfilePath, "utf8"));

		expect((await postAction(pidfile, "start", "cron")).status).toBe(200);
		await waitFor(() => {
			const cron = pidfileWorker(pidfilePath, "cron");
			return cron !== undefined && isPidAlive(cron.pid);
		});
		// Give a wrongly-cascaded restart every chance to have happened by now.
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(pidfileWorker(pidfilePath, "dependent")?.pid).toBe(dependentBefore);
		const dependentLog = readFileSync(
			join(tmpDir, "logs", "dependent.log"),
			"utf8",
		);
		expect(dependentLog).not.toContain("stopping (dependency restarted)");

		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 10000);
});

describe("runManager beforeRestart", () => {
	let tmpDir: string;
	let pidfilePath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "braid-before-restart-test-"));
		pidfilePath = join(tmpDir, "run.json");
	});

	afterEach(async () => {
		// Safety net, not the primary cleanup path: every test above already stops its own daemon
		// (and any dummy pids it wrote into a pidfile-shaped file) before finishing. But a test that
		// throws first - a failed assertion, an unexpected error, vitest's own timeout - would
		// otherwise skip that and leak a real, still-running process tree. forceStopFromPidfile is a
		// no-op (returns immediately) when there's nothing left to stop, so this is safe to run
		// unconditionally on every test, not just failures.
		await forceStopFromPidfile(pidfilePath);
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

describe("findRunningPidfile", () => {
	let tmpDir: string;
	let pidfilePath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "braid-find-running-"));
		pidfilePath = join(tmpDir, "run.json");
	});

	afterEach(async () => {
		// Safety net, not the primary cleanup path: every test above already stops its own daemon
		// (and any dummy pids it wrote into a pidfile-shaped file) before finishing. But a test that
		// throws first - a failed assertion, an unexpected error, vitest's own timeout - would
		// otherwise skip that and leak a real, still-running process tree. forceStopFromPidfile is a
		// no-op (returns immediately) when there's nothing left to stop, so this is safe to run
		// unconditionally on every test, not just failures.
		await forceStopFromPidfile(pidfilePath);
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("considers the pidfile running when a worker is alive even though the manager itself is dead", async () => {
		const dummy = spawn(process.execPath, [
			"-e",
			"setInterval(() => {}, 1000)",
		]);
		await new Promise<void>((resolve) => dummy.once("spawn", () => resolve()));
		const managerPid = await deadPid();

		writeFileSync(
			pidfilePath,
			JSON.stringify({
				managerPid,
				startedAt: new Date().toISOString(),
				workers: [
					{
						name: "solo",
						pid: dummy.pid,
						startedAt: new Date().toISOString(),
					},
				],
				controlPort: 1,
				controlToken: "x",
			}),
		);

		expect(findRunningPidfile(pidfilePath)).toBeDefined();

		dummy.kill();
	});

	it("returns undefined once every pid in the pidfile - manager and every worker - is dead", async () => {
		const managerPid = await deadPid();
		const workerPid = await deadPid();

		writeFileSync(
			pidfilePath,
			JSON.stringify({
				managerPid,
				startedAt: new Date().toISOString(),
				workers: [
					{ name: "solo", pid: workerPid, startedAt: new Date().toISOString() },
				],
				controlPort: 1,
				controlToken: "x",
			}),
		);

		expect(findRunningPidfile(pidfilePath)).toBeUndefined();
	});
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

describe("unexpected deaths: braid's own wrapper processes", () => {
	let tmpDir: string;
	let pidfilePath: string;
	const leftoverPids: number[] = [];

	/** The app's own pid, from the `started <pid>` line every fixture app prints first. */
	function appPidFromLog(name: string): number | undefined {
		const logPath = join(dirname(pidfilePath), "logs", `${name}.log`);
		if (!existsSync(logPath)) return undefined;
		const match = /started (\d+)/.exec(readFileSync(logPath, "utf8"));
		return match ? Number(match[1]) : undefined;
	}

	async function waitForAppPid(name: string): Promise<number> {
		await waitFor(() => appPidFromLog(name) !== undefined, { timeoutMs: 8000 });
		const pid = appPidFromLog(name) as number;
		leftoverPids.push(pid);
		return pid;
	}

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "braid-unexpected-"));
		pidfilePath = join(tmpDir, ".braid", "run.json");
	});

	afterEach(async () => {
		await forceStopFromPidfile(pidfilePath);
		for (const pid of leftoverPids.splice(0)) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// already gone, as it should be
			}
		}
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("treats a command that can't be spawned as a crash, stopping the stack", async () => {
		const stderr = vi.spyOn(process.stderr, "write");
		const exit = runManager(
			[
				{ name: "bad", command: "definitely-not-a-binary-braid-test" },
				{
					name: "ok",
					command: "node",
					args: [join(FIXTURES, "keep-alive.js")],
					// Kept up long enough that the crash, not a clean finish, is what stops it.
				},
			],
			pidfilePath,
		);
		expect(await exit).toBe(1);
		expect(
			stderr.mock.calls.some(([line]) =>
				String(line).includes('"bad" crashed, stopping all processes'),
			),
		).toBe(true);
		const badLog = readFileSync(
			join(dirname(pidfilePath), "logs", "bad.log"),
			"utf8",
		);
		expect(badLog).toContain(
			'braid: failed to start "definitely-not-a-binary-braid-test"',
		);
		stderr.mockRestore();
	}, 15000);

	it("treats a worker that dies from its own internal error (no crash report) as a crash", async () => {
		const stderr = vi.spyOn(process.stderr, "write");
		const exit = runManager(
			[
				// Not an array - spawn() throws inside the worker itself, before it can report anything.
				{ name: "broken", command: "node", args: "dev" as unknown as string[] },
				{
					name: "ok",
					command: "node",
					args: [join(FIXTURES, "keep-alive.js")],
				},
			],
			pidfilePath,
		);
		expect(await exit).toBe(1);
		expect(
			stderr.mock.calls.some(([line]) =>
				String(line).includes('"broken" worker exited unexpectedly (code 1)'),
			),
		).toBe(true);
		stderr.mockRestore();
	}, 15000);

	it("treats a SIGKILLed worker as a crash, and kills the app it left behind", async () => {
		const exit = runManager(
			[
				{
					name: "solo",
					command: "node",
					args: [join(FIXTURES, "keep-alive.js")],
				},
			],
			pidfilePath,
		);
		const appPid = await waitForAppPid("solo");
		const [worker] = statusFromPidfile(pidfilePath);
		process.kill(worker.pid, "SIGKILL");

		expect(await exit).toBe(1);
		await waitFor(() => !isPidAlive(appPid));
	}, 15000);

	it("doesn't treat a one-shot process's clean exit as a crash", async () => {
		const exit = runManager(
			[{ name: "once", command: "node", args: ["-e", "process.exit(0)"] }],
			pidfilePath,
		);
		expect(await exit).toBe(0);
	}, 15000);

	describe("a manager that dies or is interrupted", () => {
		const managers: ReturnType<typeof spawn>[] = [];

		afterEach(() => {
			for (const manager of managers.splice(0)) {
				if (manager.exitCode === null && manager.signalCode === null) {
					manager.kill("SIGKILL");
				}
			}
		});

		/** Runs runManager in a separate process group of its own, so tests can signal it (or its
		 *  whole group) without hitting the test runner. */
		function startManagerProcess(configs: ProcessConfig[]) {
			const manager = spawn(
				process.execPath,
				[
					...sourceExecArgv(import.meta.url),
					join(FIXTURES, "run-manager.mjs"),
					JSON.stringify(configs),
					pidfilePath,
				],
				{ cwd: tmpDir, detached: true, stdio: ["ignore", "pipe", "pipe"] },
			);
			let stderr = "";
			manager.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			managers.push(manager);
			const exited = new Promise<number | null>((resolve) =>
				manager.once("exit", (code) => resolve(code)),
			);
			return { manager, exited, stderr: () => stderr };
		}

		it("stops a silent app when the manager is SIGKILLed", async () => {
			const { manager, exited } = startManagerProcess([
				{
					name: "quiet",
					command: "node",
					args: [join(FIXTURES, "keep-alive.js")],
				},
			]);
			const appPid = await waitForAppPid("quiet");
			manager.kill("SIGKILL");
			await exited;
			await waitFor(() => !isPidAlive(appPid), { timeoutMs: 8000 });
		}, 20000);

		it("stops a constantly-writing app when the manager is SIGKILLed (no EPIPE death first)", async () => {
			const { manager, exited } = startManagerProcess([
				{
					name: "stream",
					command: "node",
					args: [join(FIXTURES, "stream-forever.js")],
				},
			]);
			const appPid = await waitForAppPid("stream");
			manager.kill("SIGKILL");
			await exited;
			await waitFor(() => !isPidAlive(appPid), { timeoutMs: 8000 });
		}, 20000);

		it("escalates to SIGKILL for an app that ignores SIGTERM when the manager is SIGKILLed", async () => {
			const { manager, exited } = startManagerProcess([
				{
					name: "stubborn",
					command: "node",
					args: [join(FIXTURES, "stream-forever.js"), "trap-term"],
					stopTimeoutMs: 500,
				},
			]);
			const appPid = await waitForAppPid("stubborn");
			manager.kill("SIGKILL");
			await exited;
			await waitFor(() => !isPidAlive(appPid), { timeoutMs: 8000 });
		}, 20000);

		it.skipIf(process.platform === "win32")(
			"stops an app that ignores SIGINT on a foreground Ctrl-C, exiting cleanly with no crash reported",
			async () => {
				const { manager, exited, stderr } = startManagerProcess([
					{
						name: "trapint",
						command: "sh",
						args: [
							"-c",
							"trap '' INT; echo started $$; while true; do sleep 0.2; done",
						],
					},
				]);
				const appPid = await waitForAppPid("trapint");
				// What a terminal does on Ctrl-C: SIGINT to the whole foreground process group.
				process.kill(-(manager.pid as number), "SIGINT");
				expect(await exited).toBe(0);
				await waitFor(() => !isPidAlive(appPid), { timeoutMs: 8000 });
				expect(stderr()).not.toContain("crashed");
			},
			20000,
		);
	});
});

describe("shutdownBudgetMs", () => {
	it("covers the daemonShutdown window, the slowest single stop, and a margin", () => {
		// 2000 (event window) + max(5000 hook default, 9000+2000 worker budget) + 2000
		expect(
			shutdownBudgetMs([
				{ name: "a", command: "node" },
				{ name: "b", command: "node", stopTimeoutMs: 9000 },
			]),
		).toBe(2000 + 11_000 + 2000);
		// With only fast configs, a hook child's default 5000 still sets the floor... except every
		// worker's own budget already includes its 2000 grace over the 5000 default.
		expect(shutdownBudgetMs([{ name: "a", command: "node" }])).toBe(
			2000 + 7000 + 2000,
		);
		expect(shutdownBudgetMs([])).toBe(2000 + 5000 + 2000);
	});
});

describe("runManager: signal option and pidfile write failures", () => {
	let tmpDir: string;
	let pidfilePath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "braid-signal-"));
		pidfilePath = join(tmpDir, ".braid", "run.json");
	});

	afterEach(async () => {
		if (existsSync(dirname(pidfilePath)))
			chmodSync(dirname(pidfilePath), 0o700);
		await forceStopFromPidfile(pidfilePath);
		rmSync(tmpDir, { recursive: true, force: true });
	});

	const keepAlive = (name: string): ProcessConfig => ({
		name,
		command: "node",
		args: [join(FIXTURES, "keep-alive.js")],
	});

	it("shuts down with code 1, stopping every process, when its signal aborts", async () => {
		const controller = new AbortController();
		const managerPromise = runManager([keepAlive("solo")], pidfilePath, {
			signal: controller.signal,
		});
		await waitFor(() => existsSync(pidfilePath));
		const [worker] = statusFromPidfile(pidfilePath);

		controller.abort();

		expect(await managerPromise).toBe(1);
		expect(isPidAlive(worker.pid)).toBe(false);
		expect(existsSync(pidfilePath)).toBe(false);
	}, 10000);

	it("shuts straight down once started if its signal was already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		expect(
			await runManager([keepAlive("solo")], pidfilePath, {
				signal: controller.signal,
			}),
		).toBe(1);
	}, 10000);

	it("ignores a crash that lands after a shutdown has already started", async () => {
		const stderr = vi.spyOn(process.stderr, "write");
		const controller = new AbortController();
		const managerPromise = runManager(
			[
				// Crashes ~500ms in: inside the shutdown below, which the plugin holds open for 1.5s
				// before any process is asked to stop.
				{
					name: "late",
					command: "node",
					args: [join(FIXTURES, "exit-fail.js"), "500"],
				},
			],
			pidfilePath,
			{
				plugins: [join(FIXTURES, "plugins", "slow-shutdown-plugin.js")],
				configPath: join(tmpDir, "braid.config.ts"),
				signal: controller.signal,
			},
		);
		await waitFor(() => existsSync(pidfilePath));
		controller.abort();

		expect(await managerPromise).toBe(1);
		expect(
			stderr.mock.calls.some(([line]) =>
				String(line).includes('"late" crashed, stopping all processes'),
			),
		).toBe(false);
		stderr.mockRestore();
	}, 15000);

	it.skipIf(process.getuid?.() === 0)(
		"keeps running when a later pidfile rewrite fails, logging it once until a write succeeds again",
		async () => {
			const stderr = vi.spyOn(process.stderr, "write");
			const managerPromise = runManager([keepAlive("solo")], pidfilePath);
			await waitFor(() => existsSync(pidfilePath));
			const pidfile = JSON.parse(readFileSync(pidfilePath, "utf8")) as Pidfile;
			const restart = () =>
				fetch(
					`http://127.0.0.1:${pidfile.controlPort}/api/processes/restart?name=solo`,
					{
						method: "POST",
						headers: { Authorization: `Bearer ${pidfile.controlToken}` },
					},
				);
			const failureLines = () =>
				stderr.mock.calls.filter(([line]) =>
					String(line).includes("couldn't update the pidfile"),
				).length;

			// A read-only .braid: the temp file a rewrite goes through can't be created.
			const braidDir = dirname(pidfilePath);
			chmodSync(braidDir, 0o500);
			expect((await restart()).status).toBe(200);
			expect((await restart()).status).toBe(200);
			expect(failureLines()).toBe(1);

			// Writable again: the next rewrite succeeds and re-arms the one-shot log.
			chmodSync(braidDir, 0o700);
			expect((await restart()).status).toBe(200);
			chmodSync(braidDir, 0o500);
			expect((await restart()).status).toBe(200);
			expect(failureLines()).toBe(2);

			// One more successful rewrite, so the pidfile names the live worker again - in-process,
			// stopFromPidfile can only stop what the pidfile points at.
			chmodSync(braidDir, 0o700);
			expect((await restart()).status).toBe(200);
			stderr.mockRestore();
			await stopFromPidfile(pidfilePath);
			await managerPromise;
		},
		20000,
	);
});

describe("stopFromPidfile", () => {
	let tmpDir: string;
	let pidfilePath: string;
	const spawned: ReturnType<typeof spawn>[] = [];

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "braid-stop-"));
		pidfilePath = join(tmpDir, ".braid", "run.json");
		mkdirSync(dirname(pidfilePath), { recursive: true });
	});

	afterEach(async () => {
		await forceStopFromPidfile(pidfilePath);
		for (const child of spawned.splice(0)) {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGKILL");
			}
		}
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function track(child: ReturnType<typeof spawn>) {
		spawned.push(child);
		return child;
	}

	/** A plain keep-alive process braid didn't start, with its pid once it's running. */
	async function startStray(): Promise<number> {
		const child = track(
			spawn(process.execPath, [join(FIXTURES, "keep-alive.js")]),
		);
		await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
		return child.pid as number;
	}

	function startManagerProcess(configs: ProcessConfig[]) {
		const manager = track(
			spawn(
				process.execPath,
				[
					...sourceExecArgv(import.meta.url),
					join(FIXTURES, "run-manager.mjs"),
					JSON.stringify(configs),
					pidfilePath,
				],
				{ cwd: tmpDir, stdio: "ignore" },
			),
		);
		const exited = new Promise<void>((resolve) =>
			manager.once("exit", () => resolve()),
		);
		return { manager, exited };
	}

	function appPidFromLog(name: string): number | undefined {
		const logPath = join(dirname(pidfilePath), "logs", `${name}.log`);
		if (!existsSync(logPath)) return undefined;
		const match = /started (\d+)/.exec(readFileSync(logPath, "utf8"));
		return match ? Number(match[1]) : undefined;
	}

	const writePidfile = (pidfile: Partial<Pidfile>) =>
		writeFileSync(
			pidfilePath,
			JSON.stringify({
				startedAt: new Date().toISOString(),
				workers: [],
				controlPort: 1,
				controlToken: "t",
				...pidfile,
			}),
		);

	it("asks a manager in another process to stop, and returns only once its apps are gone", async () => {
		const { manager, exited } = startManagerProcess([
			{
				name: "solo",
				command: "node",
				args: [join(FIXTURES, "keep-alive.js")],
			},
		]);
		await waitFor(() => appPidFromLog("solo") !== undefined, {
			timeoutMs: 8000,
		});
		const appPid = appPidFromLog("solo") as number;

		expect(await stopFromPidfile(pidfilePath)).toEqual(["solo"]);
		// Already gone - not merely signalled - the moment stopFromPidfile resolves.
		expect(isPidAlive(appPid)).toBe(false);
		expect(isPidAlive(manager.pid as number)).toBe(false);
		await exited;
		expect(existsSync(pidfilePath)).toBe(false);
	}, 20000);

	it("lets an immediate start after a stop keep its own pidfile, even when the old stack was slow to stop", async () => {
		const slow: ProcessConfig = {
			name: "slow",
			command: "node",
			args: [join(FIXTURES, "ignore-sigterm.js")],
			stopTimeoutMs: 1000,
		};
		startManagerProcess([slow]);
		await waitFor(() => appPidFromLog("slow") !== undefined, {
			timeoutMs: 8000,
		});

		await stopFromPidfile(pidfilePath);
		const second = startManagerProcess([
			{
				name: "next",
				command: "node",
				args: [join(FIXTURES, "keep-alive.js")],
			},
		]);
		await waitFor(() => existsSync(pidfilePath), { timeoutMs: 8000 });
		// Well past the old stack's own stop budget: had it still been tearing down, it would have
		// deleted this pidfile by now.
		await new Promise((resolve) => setTimeout(resolve, 2500));
		const pidfile = JSON.parse(readFileSync(pidfilePath, "utf8")) as Pidfile;
		expect(pidfile.managerPid).toBe(second.manager.pid);
		expect(findRunningPidfile(pidfilePath)).toBeDefined();
	}, 30000);

	it("SIGKILLs a manager that refuses to shut down and ignores SIGTERM, once the pidfile's deadline passes", async () => {
		const fake = track(
			spawn(
				process.execPath,
				[join(FIXTURES, "fake-manager.mjs"), pidfilePath, "500"],
				{
					stdio: ["ignore", "pipe", "ignore"],
				},
			),
		);
		await new Promise<void>((resolve) =>
			fake.stdout?.once("data", () => resolve()),
		);

		const startedAt = Date.now();
		await stopFromPidfile(pidfilePath);
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(450);
		await waitFor(() => fake.exitCode !== null || fake.signalCode !== null);
		expect(fake.signalCode).toBe("SIGKILL");
		expect(existsSync(pidfilePath)).toBe(false);
	}, 15000);

	it("stops workers a dead manager left behind, from a pidfile written by an older braid", async () => {
		const orphan = await startStray();
		writePidfile({
			managerPid: await deadPid(),
			workers: [
				{ name: "orphan", pid: orphan, startedAt: new Date().toISOString() },
			],
		});

		expect(await stopFromPidfile(pidfilePath)).toEqual(["orphan"]);
		expect(isPidAlive(orphan)).toBe(false);
		expect(existsSync(pidfilePath)).toBe(false);
	}, 15000);

	it("never signals a pid that now belongs to a process started after the pidfile was written", async () => {
		const unrelated = await startStray();
		const anHourAgo = new Date(Date.now() - 3600_000).toISOString();
		writePidfile({
			managerPid: await deadPid(),
			startedAt: anHourAgo,
			workers: [{ name: "reused", pid: unrelated, startedAt: anHourAgo }],
		});

		expect(findRunningPidfile(pidfilePath)).toBeUndefined();
		expect(statusFromPidfile(pidfilePath)).toEqual([
			expect.objectContaining({ name: "reused", alive: false }),
		]);
		expect(await stopFromPidfile(pidfilePath)).toEqual([]);
		expect(isPidAlive(unrelated)).toBe(true);
		// The stale pidfile itself is still cleaned up.
		expect(existsSync(pidfilePath)).toBe(false);
	}, 15000);

	it("stops workers directly when it can't reach its own in-process manager", async () => {
		const worker = await startStray();
		writePidfile({
			managerPid: process.pid,
			workers: [
				{ name: "w", pid: worker, startedAt: new Date().toISOString() },
			],
		});

		expect(await stopFromPidfile(pidfilePath)).toEqual(["w"]);
		expect(isPidAlive(worker)).toBe(false);
		expect(isPidAlive(process.pid)).toBe(true);
	}, 15000);

	it("SIGKILLs a dead manager's leftover worker that ignores SIGTERM, once the deadline passes", async () => {
		const stubborn = track(
			spawn(process.execPath, [join(FIXTURES, "ignore-sigterm.js")], {
				stdio: ["ignore", "pipe", "ignore"],
			}),
		);
		// Its "started" line means its SIGTERM handler is installed.
		await new Promise<void>((resolve) =>
			stubborn.stdout?.once("data", () => resolve()),
		);
		writePidfile({
			managerPid: await deadPid(),
			shutdownTimeoutMs: 300,
			workers: [
				{
					name: "stubborn",
					pid: stubborn.pid as number,
					startedAt: new Date().toISOString(),
				},
			],
		});

		expect(await stopFromPidfile(pidfilePath)).toEqual(["stubborn"]);
		await waitFor(() => stubborn.signalCode !== null);
		expect(stubborn.signalCode).toBe("SIGKILL");
	}, 15000);

	it("lets a plugin shut the daemon down once it's up, but ignores a call made during register()", async () => {
		const stderr = vi.spyOn(process.stderr, "write");
		const configPath = join(tmpDir, "braid.config.ts");
		const keepAlive: ProcessConfig[] = [
			{
				name: "solo",
				command: "node",
				args: [join(FIXTURES, "keep-alive.js")],
			},
		];
		const plugin = join(FIXTURES, "plugins", "shutdown-plugin.js");

		const early = runManager(keepAlive, pidfilePath, {
			plugins: [[plugin, { when: "register" }]],
			configPath,
		});
		await waitFor(() => existsSync(pidfilePath));
		expect(
			stderr.mock.calls.some(([line]) =>
				String(line).includes(
					"ignoring a plugin's shutdown() call during startup",
				),
			),
		).toBe(true);
		await stopFromPidfile(pidfilePath);
		expect(await early).toBe(0);

		expect(
			await runManager(keepAlive, pidfilePath, {
				plugins: [[plugin, { when: "ready" }]],
				configPath,
			}),
		).toBe(0);
		stderr.mockRestore();
	}, 15000);

	it("leaves a pidfile alone on shutdown once another run has replaced it", async () => {
		const controller = new AbortController();
		const managerPromise = runManager(
			[
				{
					name: "solo",
					command: "node",
					args: [join(FIXTURES, "keep-alive.js")],
				},
			],
			pidfilePath,
			{ signal: controller.signal },
		);
		await waitFor(() => existsSync(pidfilePath));
		const replaced = {
			...(JSON.parse(readFileSync(pidfilePath, "utf8")) as Pidfile),
			controlToken: "a-newer-run",
		};
		writeFileSync(pidfilePath, JSON.stringify(replaced));

		controller.abort();
		await managerPromise;
		expect(JSON.parse(readFileSync(pidfilePath, "utf8"))).toEqual(replaced);
		rmSync(pidfilePath);
	}, 15000);
});

describe("runManager start lock", () => {
	let tmpDir: string;
	let pidfilePath: string;
	const lockPath = () => join(dirname(pidfilePath), "start.lock");
	const keepAlive: ProcessConfig[] = [
		{ name: "solo", command: "node", args: [join(FIXTURES, "keep-alive.js")] },
	];

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "braid-start-lock-"));
		pidfilePath = join(tmpDir, ".braid", "run.json");
	});

	afterEach(async () => {
		await forceStopFromPidfile(pidfilePath);
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("refuses a second manager for the same directory while the first is still starting up", async () => {
		// No await in between: the second starts before the first has written any pidfile.
		const first = runManager(keepAlive, pidfilePath);
		const second = runManager(keepAlive, pidfilePath);
		await expect(second).rejects.toThrow("braid already running or starting");

		await waitFor(() => existsSync(pidfilePath));
		await stopFromPidfile(pidfilePath);
		expect(await first).toBe(0);
		expect(existsSync(lockPath())).toBe(false);
	}, 15000);

	it("doesn't take the lock at all for a config that fails validation", async () => {
		await expect(
			runManager(
				[
					{ name: "dup", command: "node" },
					{ name: "dup", command: "node" },
				],
				pidfilePath,
			),
		).rejects.toThrow();
		expect(existsSync(lockPath())).toBe(false);
	});
});

describe("restarting a process that hasn't had its first spawn yet", () => {
	let tmpDir: string;
	let pidfilePath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "braid-pending-restart-"));
		pidfilePath = join(tmpDir, ".braid", "run.json");
	});

	afterEach(async () => {
		await forceStopFromPidfile(pidfilePath);
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("starts it once, through its own startAfter chain, rather than forking a second, untracked copy", async () => {
		const spawns = join(tmpDir, "spawns.log");
		const configs: ProcessConfig[] = [
			{
				name: "api",
				command: "node",
				args: [join(FIXTURES, "slow-start.js"), "1500"],
				readyPattern: "ready-marker",
			},
			{
				name: "web",
				command: "node",
				// Appends one line per start, so duplicate spawns are countable.
				args: [
					"-e",
					`require("fs").appendFileSync(${JSON.stringify(spawns)}, "start\\n"); setInterval(() => {}, 1000)`,
				],
				startAfter: { processes: ["api"] },
			},
		];
		const managerPromise = runManager(configs, pidfilePath);
		await waitFor(() => existsSync(pidfilePath));
		const pidfile = JSON.parse(readFileSync(pidfilePath, "utf8")) as Pidfile;

		// "web" is still waiting on "api"'s readyPattern.
		const response = await fetch(
			`http://127.0.0.1:${pidfile.controlPort}/api/processes/restart?name=web`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${pidfile.controlToken}` },
			},
		);
		expect(response.status).toBe(200);

		// Past the point "api" becomes ready - when ensureReady makes its own first spawn of "web" -
		// plus time for a duplicate to have started.
		const apiLog = join(dirname(pidfilePath), "logs", "api.log");
		await waitFor(
			() =>
				existsSync(apiLog) &&
				readFileSync(apiLog, "utf8").includes("ready-marker"),
			{ timeoutMs: 8000 },
		);
		await new Promise((resolve) => setTimeout(resolve, 1000));
		expect(readFileSync(spawns, "utf8")).toBe("start\n");
		const web = statusFromPidfile(pidfilePath).find((w) => w.name === "web");
		expect(web?.alive).toBe(true);

		await stopFromPidfile(pidfilePath);
		expect(await managerPromise).toBe(0);
	}, 20000);
});

describe("process stats", () => {
	let tmpDir: string;
	let pidfilePath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "braid-stats-"));
		pidfilePath = join(tmpDir, ".braid", "run.json");
	});

	afterEach(async () => {
		await forceStopFromPidfile(pidfilePath);
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it.skipIf(process.platform === "win32")(
		"reports the app's whole process tree - a child holding 150 MB and half a core - not braid's wrapper",
		async () => {
			const managerPromise = runManager(
				[
					{
						name: "load",
						command: "node",
						args: [join(FIXTURES, "load.js"), "parent", "150"],
					},
				],
				pidfilePath,
				{ statsPollIntervalMs: 250 },
			);
			await waitFor(() => existsSync(pidfilePath));
			const pidfile = JSON.parse(readFileSync(pidfilePath, "utf8")) as Pidfile;
			const logPath = join(dirname(pidfilePath), "logs", "load.log");
			// The child logs once it holds all its memory.
			await waitFor(
				() =>
					existsSync(logPath) &&
					readFileSync(logPath, "utf8").includes("holding"),
				{ timeoutMs: 10_000 },
			);
			const appPid = Number(
				/started (\d+)/.exec(readFileSync(logPath, "utf8"))?.[1],
			);

			type Row = {
				name: string;
				pid: number;
				appPid?: number;
				cpu?: number;
				memory?: number;
			};
			let load: Row | undefined;
			const deadline = Date.now() + 10_000;
			while (Date.now() < deadline) {
				const response = await fetch(
					`http://127.0.0.1:${pidfile.controlPort}/api/status`,
					{ headers: { Authorization: `Bearer ${pidfile.controlToken}` } },
				);
				load = ((await response.json()) as Row[]).find(
					(row) => row.name === "load",
				);
				// Memory must cover the child's 150 MB; braid's wrapper alone is ~30-50 MB.
				if ((load?.memory ?? 0) > 140 * 1024 * 1024 && (load?.cpu ?? 0) > 20)
					break;
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
			expect(load?.appPid).toBe(appPid);
			expect(load?.appPid).not.toBe(load?.pid);
			expect(load?.memory).toBeGreaterThan(140 * 1024 * 1024);
			// The child burns ~50% of a core; leave room for a loaded CI machine.
			expect(load?.cpu).toBeGreaterThan(20);

			await stopFromPidfile(pidfilePath);
			expect(await managerPromise).toBe(0);
		},
		30_000,
	);
});

describe("runManager name validation", () => {
	it("rejects a process name that would put its log outside the logs directory, before taking the lock or spawning anything", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "braid-names-"));
		const pidfilePath = join(tmpDir, ".braid", "run.json");
		try {
			await expect(
				runManager([{ name: "../escape", command: "node" }], pidfilePath),
			).rejects.toThrow('process name "../escape" contains a path separator');
			expect(existsSync(join(tmpDir, ".braid", "start.lock"))).toBe(false);
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});

describe("readyPattern matching", () => {
	let tmpDir: string;
	let pidfilePath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "braid-ready-"));
		pidfilePath = join(tmpDir, ".braid", "run.json");
	});

	afterEach(async () => {
		await forceStopFromPidfile(pidfilePath);
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("matches an anchored pattern against the app's own text, even with timestamps and colors on", async () => {
		const stderr = vi.spyOn(process.stderr, "write");
		const startedAt = Date.now();
		const managerPromise = runManager(
			[
				{
					name: "api",
					color: "blue",
					command: "node",
					args: [join(FIXTURES, "slow-start.js"), "200"],
					// slow-start prints "ready-marker <pid>". Anchored, which only works once braid's
					// own "HH:MM:SS.mmm [api] " prefix isn't part of what's matched.
					readyPattern: "^ready-marker \\d+$",
					readyTimeoutMs: 5000,
				},
				{
					name: "web",
					command: "node",
					args: [join(FIXTURES, "keep-alive.js")],
					startAfter: { processes: ["api"] },
				},
			],
			pidfilePath,
			{ logs: { timestamps: true } },
		);
		await waitFor(
			() => statusFromPidfile(pidfilePath).some((w) => w.name === "web"),
			{ timeoutMs: 8000 },
		);
		// Well inside the 5s readyTimeoutMs: it matched, rather than timing out.
		expect(Date.now() - startedAt).toBeLessThan(4000);
		expect(
			stderr.mock.calls.some(([line]) =>
				String(line).includes("never matched"),
			),
		).toBe(false);
		stderr.mockRestore();
		await stopFromPidfile(pidfilePath);
		await managerPromise;
	}, 15000);
});

describe("output printed while shutting down", () => {
	it("still reaches the process's log", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "braid-shutdown-output-"));
		const pidfilePath = join(tmpDir, ".braid", "run.json");
		try {
			const controller = new AbortController();
			const managerPromise = runManager(
				[
					{
						name: "app",
						command: "node",
						args: [join(FIXTURES, "graceful-exit.js")],
					},
				],
				pidfilePath,
				{ signal: controller.signal },
			);
			const logPath = join(dirname(pidfilePath), "logs", "app.log");
			await waitFor(
				() =>
					existsSync(logPath) &&
					readFileSync(logPath, "utf8").includes("started"),
			);
			controller.abort();
			await managerPromise;

			const log = readFileSync(logPath, "utf8");
			expect(log).toContain("braid: stopping");
			expect(log).toContain("graceful shutdown, flushing state");
			expect(log).toContain("done, bye");
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	}, 15000);
});
