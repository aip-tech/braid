import { type ChildProcess, fork } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import treeKill from "tree-kill";
import type {
	Pidfile,
	PidfileWorker,
	ProcessConfig,
	WorkerStatusMessage,
} from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Compiled output (dist/manager.js) sits next to a compiled dist/worker.js; running straight from
// source (dev, tests) sits next to worker.ts and needs tsx's loader to fork() it directly.
const RUNNING_FROM_SOURCE = __filename.endsWith(".ts");
const WORKER_PATH = join(
	__dirname,
	RUNNING_FROM_SOURCE ? "worker.ts" : "worker.js",
);

function readPidfile(pidfilePath: string): Pidfile | undefined {
	if (!existsSync(pidfilePath)) return undefined;
	try {
		return JSON.parse(readFileSync(pidfilePath, "utf8")) as Pidfile;
	} catch {
		return undefined;
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function killPid(pid: number): Promise<void> {
	return new Promise((resolve) => {
		treeKill(pid, "SIGTERM", () => resolve());
	});
}

/** Returns the pidfile's contents, but only if at least one PID in it is still alive. */
export function findRunningPidfile(pidfilePath: string): Pidfile | undefined {
	const pidfile = readPidfile(pidfilePath);
	if (!pidfile) return undefined;
	const anyAlive =
		isAlive(pidfile.managerPid) ||
		pidfile.workers.some((worker) => isAlive(worker.pid));
	return anyAlive ? pidfile : undefined;
}

/** Kills every process recorded in the pidfile (and their descendants), then removes it. */
export async function stopFromPidfile(pidfilePath: string): Promise<string[]> {
	const pidfile = readPidfile(pidfilePath);
	if (!pidfile) return [];

	const stopped: string[] = [];
	for (const worker of pidfile.workers) {
		if (isAlive(worker.pid)) {
			await killPid(worker.pid);
			stopped.push(worker.name);
		}
	}
	// Guard against a manager process calling stopFromPidfile on itself (e.g. a library consumer
	// running start/stop in the same process): tree-killing your own PID takes the whole calling
	// process's tree down with it, which is never the intent of a "stop the other processes" call.
	if (pidfile.managerPid !== process.pid && isAlive(pidfile.managerPid)) {
		await killPid(pidfile.managerPid);
	}
	rmSync(pidfilePath, { force: true });
	return stopped;
}

export function statusFromPidfile(
	pidfilePath: string,
): Array<PidfileWorker & { alive: boolean }> {
	const pidfile = readPidfile(pidfilePath);
	if (!pidfile) return [];
	return pidfile.workers.map((worker) => ({
		...worker,
		alive: isAlive(worker.pid),
	}));
}

/**
 * Forks one worker per config, tracks their PIDs in a pidfile, and mirrors concurrently's
 * `--kill-others-on-fail`: if any worker crashes, every other worker is killed and the returned
 * exit code is non-zero. Resolves once every worker has exited (cleanly or via SIGINT/SIGTERM).
 */
export async function runManager(
	configs: ProcessConfig[],
	pidfilePath: string,
): Promise<number> {
	const running = findRunningPidfile(pidfilePath);
	if (running) {
		throw new Error(
			`braid already running (pid ${running.managerPid}). Run "stop" first, or delete ${pidfilePath} if that's stale.`,
		);
	}

	mkdirSync(dirname(pidfilePath), { recursive: true });

	const children = new Map<string, ChildProcess>();
	const pidfileWorkers: PidfileWorker[] = [];
	let shuttingDown = false;
	let exitCode = 0;

	const onSignal = (): void => {
		void shutdown(0);
	};

	const shutdown = async (code: number): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		exitCode = code;
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		await Promise.all(
			[...children.values()]
				.map((child) => child.pid)
				.filter((pid): pid is number => typeof pid === "number")
				.map((pid) => killPid(pid)),
		);
		rmSync(pidfilePath, { force: true });
	};

	const exitPromises: Promise<void>[] = [];

	for (const config of configs) {
		const child = fork(WORKER_PATH, [], {
			cwd: config.cwd ? join(process.cwd(), config.cwd) : process.cwd(),
			env: {
				...process.env,
				...config.env,
				BRAID_CONFIG: JSON.stringify(config),
			},
			// Only the source (.ts) worker needs tsx's loader; the compiled worker.js is plain JS a
			// published package's consumers can run with no TypeScript tooling installed at all.
			execArgv: RUNNING_FROM_SOURCE
				? [...process.execArgv, "--import", "tsx"]
				: process.execArgv,
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		children.set(config.name, child);
		if (typeof child.pid === "number") {
			pidfileWorkers.push({ name: config.name, pid: child.pid });
		}

		child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(chunk));
		child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));

		child.on("message", (message: WorkerStatusMessage) => {
			if (message.type === "crash" && !shuttingDown) {
				process.stderr.write(
					`[braid] "${config.name}" crashed, stopping all processes\n`,
				);
				void shutdown(1);
			}
		});
		child.on("error", (error) => {
			if (!shuttingDown) {
				process.stderr.write(
					`[braid] "${config.name}" failed to start: ${error.message}\n`,
				);
				void shutdown(1);
			}
		});

		exitPromises.push(
			new Promise((resolve) => child.on("exit", () => resolve())),
		);
	}

	const pidfile: Pidfile = {
		managerPid: process.pid,
		startedAt: new Date().toISOString(),
		workers: pidfileWorkers,
	};
	writeFileSync(pidfilePath, JSON.stringify(pidfile, null, 2));

	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);

	await Promise.all(exitPromises);
	return exitCode;
}
