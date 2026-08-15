import { type ChildProcess, fork } from "node:child_process";
import { EventEmitter } from "node:events";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import treeKill from "tree-kill";
import { createControlServer } from "./control-server.js";
import { CORE_PLUGINS } from "./core-plugins/index.js";
import { siblingModulePath, sourceExecArgv } from "./module-path.js";
import { loadExternalPlugins } from "./plugin-loader.js";
import {
	createPluginContextFactory,
	registerPlugin,
	safeEmit,
} from "./plugin-runtime.js";
import type {
	BraidConfig,
	Pidfile,
	PidfileWorker,
	PluginConfigEntry,
	ProcessConfig,
	WorkerStatusMessage,
} from "./types.js";

const WORKER_PATH = siblingModulePath(import.meta.url, "worker");

// How long shutdown() waits for daemonShutdown listeners before proceeding regardless -
// a plugin gets a real chance to react to teardown, but a hung listener can't block it forever.
const SHUTDOWN_EVENT_TIMEOUT_MS = 2000;

export type RunManagerOptions = {
	/** External plugins to load, resolved relative to configPath. */
	plugins?: PluginConfigEntry[];
	/** The config file plugin specifiers are resolved against. Required if `plugins` is non-empty. */
	configPath?: string;
	/** Per-process log file settings, forwarded to the core logger plugin. */
	logs?: BraidConfig["logs"];
	/** Called once every process has forked and the pidfile is written, before awaiting exit. */
	onReady?: () => void;
};

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
 *
 * Also starts a loopback-only, bearer-token-guarded control server (see control-server.ts): every
 * core plugin (core-plugins/) and every external plugin named in `options.plugins` registers
 * routes/static dirs/upgrade handlers and lifecycle listeners on it through the same
 * PluginContext, and its port + token are recorded in the pidfile.
 */
export async function runManager(
	configs: ProcessConfig[],
	pidfilePath: string,
	options: RunManagerOptions = {},
): Promise<number> {
	const running = findRunningPidfile(pidfilePath);
	if (running) {
		throw new Error(
			`braid already running (pid ${running.managerPid}). Run "stop" first, or delete ${pidfilePath} if that's stale.`,
		);
	}
	if (options.plugins && options.plugins.length > 0 && !options.configPath) {
		throw new Error(
			"braid: options.configPath is required to resolve options.plugins",
		);
	}

	mkdirSync(dirname(pidfilePath), { recursive: true });
	const logsDir = options.logs?.dir ?? join(dirname(pidfilePath), "logs");

	const children = new Map<string, ChildProcess>();
	const pidfileWorkers: PidfileWorker[] = [];
	let shuttingDown = false;
	let exitCode = 0;

	const emitter = new EventEmitter();
	const controlServer = createControlServer();
	const getWorkers = () =>
		pidfileWorkers.map((worker) => ({
			name: worker.name,
			pid: worker.pid,
			alive: isAlive(worker.pid),
			startedAt: worker.startedAt,
		}));
	const contextFor = createPluginContextFactory({
		controlServer,
		getWorkers,
		emitter,
	});

	// Core plugins registered by name that need config get it looked up here, rather than every
	// core plugin uniformly receiving the same options object regardless of relevance to it.
	const corePluginOptions: Record<string, Record<string, unknown>> = {
		"core:logger": {
			dir: logsDir,
			maxSizeBytes: options.logs?.maxSizeBytes,
		},
	};
	for (const plugin of CORE_PLUGINS) {
		await registerPlugin(
			plugin,
			contextFor(plugin.name),
			corePluginOptions[plugin.name],
		);
	}
	if (options.plugins && options.plugins.length > 0) {
		// options.configPath is guaranteed set here by the guard above.
		await loadExternalPlugins(
			options.plugins,
			options.configPath as string,
			contextFor,
		);
	}
	const { port: controlPort } = await controlServer.listen();

	const onSignal = (): void => {
		void shutdown(0);
	};

	const shutdown = async (code: number): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		exitCode = code;
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);

		await Promise.race([
			safeEmit(emitter, "daemonShutdown", { type: "daemonShutdown" }),
			new Promise((resolve) => setTimeout(resolve, SHUTDOWN_EVENT_TIMEOUT_MS)),
		]);

		await Promise.all([
			...[...children.values()]
				.map((child) => child.pid)
				.filter((pid): pid is number => typeof pid === "number")
				.map((pid) => killPid(pid)),
			controlServer.close(),
		]);
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
			// Not process.execArgv: if this process itself was started with a bare "--import tsx",
			// forwarding it would race an unresolved "tsx" (unreachable from a worker with a different
			// cwd, e.g. via config.cwd) against the properly pre-resolved one sourceExecArgv returns.
			execArgv: sourceExecArgv(import.meta.url),
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		children.set(config.name, child);
		if (typeof child.pid === "number") {
			pidfileWorkers.push({
				name: config.name,
				pid: child.pid,
				startedAt: new Date().toISOString(),
			});
			void safeEmit(emitter, "processStart", {
				type: "processStart",
				name: config.name,
				pid: child.pid,
			});
		}

		// No terminal to relay to any more (start always daemonizes) - the core logger plugin is
		// the one consumer that persists these to per-process rotated log files.
		child.stdout?.on("data", (chunk: Buffer) => {
			void safeEmit(emitter, "processOutput", {
				type: "processOutput",
				name: config.name,
				stream: "stdout",
				chunk,
			});
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			void safeEmit(emitter, "processOutput", {
				type: "processOutput",
				name: config.name,
				stream: "stderr",
				chunk,
			});
		});

		child.on("message", (message: WorkerStatusMessage) => {
			if (message.type === "restart") {
				void safeEmit(emitter, "processRestart", {
					type: "processRestart",
					name: config.name,
				});
				return;
			}
			if (message.type === "crash" && !shuttingDown) {
				process.stderr.write(
					`[braid] "${config.name}" crashed, stopping all processes\n`,
				);
				void safeEmit(emitter, "processCrash", {
					type: "processCrash",
					name: config.name,
					code: message.code,
				});
				void shutdown(1);
			}
		});
		child.on("error", (error) => {
			if (!shuttingDown) {
				process.stderr.write(
					`[braid] "${config.name}" failed to start: ${error.message}\n`,
				);
				void safeEmit(emitter, "processCrash", {
					type: "processCrash",
					name: config.name,
					code: null,
				});
				void shutdown(1);
			}
		});
		child.on("exit", (code, signal) => {
			void safeEmit(emitter, "processExit", {
				type: "processExit",
				name: config.name,
				code,
				signal,
			});
		});

		exitPromises.push(
			new Promise((resolve) => child.on("exit", () => resolve())),
		);
	}

	const pidfile: Pidfile = {
		managerPid: process.pid,
		startedAt: new Date().toISOString(),
		workers: pidfileWorkers,
		controlPort,
		controlToken: controlServer.token,
	};
	writeFileSync(pidfilePath, JSON.stringify(pidfile, null, 2));
	options.onReady?.();

	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);

	await Promise.all(exitPromises);
	return exitCode;
}
