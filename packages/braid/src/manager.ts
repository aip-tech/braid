import { type ChildProcess, fork, spawn } from "node:child_process";
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
import { validateDependsOn } from "./dependency-graph.js";
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

// How long shutdown() waits for daemonShutdown listeners before proceeding regardless.
const SHUTDOWN_EVENT_TIMEOUT_MS = 2000;

const DEFAULT_HOOK_RETRIES = 5;
const DEFAULT_HOOK_RETRY_DELAY_MS = 1000;

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

/** Distinguishes braid's own worker->manager IPC protocol from nodemon's auto-forwarded events. */
function isWorkerStatusMessage(
	message: unknown,
): message is WorkerStatusMessage {
	return (
		typeof message === "object" &&
		message !== null &&
		(message as { source?: unknown }).source === "braid-worker"
	);
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

/** Resolves once `child` has actually exited (not just once a kill signal was sent). */
function waitForExit(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve();
	}
	return new Promise((resolve) => child.once("exit", () => resolve()));
}

/** Sends SIGTERM to `child`'s whole process tree and waits for it to actually exit. */
async function stopChild(child: ChildProcess): Promise<void> {
	if (typeof child.pid !== "number") return;
	const exited = waitForExit(child);
	await killPid(child.pid);
	await exited;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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
	// Don't tree-kill our own PID if called from within the manager process itself.
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

/** Builds a name -> [configs that depend on it] map from every config's `dependsOn.processes`. */
function computeDependents(
	configs: ProcessConfig[],
): Map<string, ProcessConfig[]> {
	const dependents = new Map<string, ProcessConfig[]>();
	for (const config of configs) {
		for (const dependency of config.dependsOn?.processes ?? []) {
			const list = dependents.get(dependency) ?? [];
			list.push(config);
			dependents.set(dependency, list);
		}
	}
	return dependents;
}

/**
 * Forks one worker per config, tracks PIDs in a pidfile, kills every worker if one crashes, and
 * starts the control server core and external plugins register on. Resolves once every worker
 * has exited.
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
	validateDependsOn(configs);

	mkdirSync(dirname(pidfilePath), { recursive: true });
	const logsDir = options.logs?.dir ?? join(dirname(pidfilePath), "logs");

	const children = new Map<string, ChildProcess>();
	// One-off `dependsOn.run` hook processes currently in flight, so shutdown can kill them too.
	const hookChildren = new Set<ChildProcess>();
	const pidfileWorkers: PidfileWorker[] = [];
	// Dependent names currently mid stop/hook/restart cycle, so an overlapping trigger is skipped.
	const restarting = new Set<string>();
	const dependentsByTrigger = computeDependents(configs);
	let shuttingDown = false;
	let exitCode = 0;

	let resolveExitPromise!: (code: number) => void;
	const exitPromise = new Promise<number>((resolve) => {
		resolveExitPromise = resolve;
	});

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

	// Options per core plugin, by name - not every core plugin needs config.
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
	const managerStartedAt = new Date().toISOString();

	function upsertWorkerRecord(name: string, pid: number): void {
		const record = { name, pid, startedAt: new Date().toISOString() };
		const index = pidfileWorkers.findIndex((worker) => worker.name === name);
		if (index === -1) pidfileWorkers.push(record);
		else pidfileWorkers[index] = record;
	}

	function rewritePidfile(): void {
		const pidfile: Pidfile = {
			managerPid: process.pid,
			startedAt: managerStartedAt,
			workers: pidfileWorkers,
			controlPort,
			controlToken: controlServer.token,
		};
		writeFileSync(pidfilePath, JSON.stringify(pidfile, null, 2));
	}

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
			...[...children.values()].map((child) => stopChild(child)),
			...[...hookChildren].map((child) => stopChild(child)),
			controlServer.close(),
		]);
		rmSync(pidfilePath, { force: true });
		resolveExitPromise(exitCode);
	};

	/**
	 * Runs a `dependsOn.run` hook once, its output folded into `logName`'s (the dependent's own)
	 * log; resolves true on a zero exit code.
	 */
	function runHookOnce(
		logName: string,
		hook: { command: string; args?: string[]; cwd?: string },
	): Promise<boolean> {
		return new Promise((resolve) => {
			const hookChild = spawn(hook.command, hook.args ?? [], {
				cwd: hook.cwd ? join(process.cwd(), hook.cwd) : process.cwd(),
				env: process.env,
			});
			hookChildren.add(hookChild);
			hookChild.stdout?.on("data", (chunk: Buffer) => {
				void safeEmit(emitter, "processOutput", {
					type: "processOutput",
					name: logName,
					stream: "stdout",
					chunk,
				});
			});
			hookChild.stderr?.on("data", (chunk: Buffer) => {
				void safeEmit(emitter, "processOutput", {
					type: "processOutput",
					name: logName,
					stream: "stderr",
					chunk,
				});
			});
			hookChild.on("exit", (code) => {
				hookChildren.delete(hookChild);
				resolve(code === 0);
			});
			hookChild.on("error", () => {
				hookChildren.delete(hookChild);
				resolve(false);
			});
		});
	}

	/** Retries a `dependsOn.run` hook, since its dependency may still be starting back up. */
	async function runHookWithRetries(
		logName: string,
		hook: {
			command: string;
			args?: string[];
			cwd?: string;
			retries?: number;
			retryDelayMs?: number;
		},
	): Promise<boolean> {
		const retries = hook.retries ?? DEFAULT_HOOK_RETRIES;
		const retryDelayMs = hook.retryDelayMs ?? DEFAULT_HOOK_RETRY_DELAY_MS;
		for (let attempt = 0; attempt <= retries; attempt++) {
			if (shuttingDown) return false;
			if (await runHookOnce(logName, hook)) return true;
			if (attempt < retries) await delay(retryDelayMs);
		}
		return false;
	}

	function spawnWorker(config: ProcessConfig): void {
		const child = fork(WORKER_PATH, [], {
			cwd: config.cwd ? join(process.cwd(), config.cwd) : process.cwd(),
			env: {
				...process.env,
				...config.env,
				BRAID_CONFIG: JSON.stringify(config),
			},
			execArgv: sourceExecArgv(import.meta.url),
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		children.set(config.name, child);
		if (typeof child.pid === "number") {
			upsertWorkerRecord(config.name, child.pid);
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

		child.on("message", (message: unknown) => {
			// nodemon auto-forwards its own internal bus events (restart, crash, log, ...) over this
			// same IPC channel whenever it detects it's forked - ignore anything not tagged as ours.
			if (!isWorkerStatusMessage(message)) return;
			if (message.type === "restart") {
				void safeEmit(emitter, "processRestart", {
					type: "processRestart",
					name: config.name,
				});
				onProcessRestarted(config.name);
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
			shutdownIfEveryWorkerIsDone();
		});
	}

	/**
	 * A worker that exits on its own (a one-shot config, or one killed from outside braid) doesn't
	 * trigger shutdown by itself - but once every worker has exited this way, and none are mid a
	 * dependsOn stop/restart cycle, there's nothing left running and the manager should wind down.
	 */
	function shutdownIfEveryWorkerIsDone(): void {
		if (shuttingDown || restarting.size > 0) return;
		const everyWorkerExited = [...children.values()].every(
			(child) => child.exitCode !== null || child.signalCode !== null,
		);
		if (everyWorkerExited) void shutdown(0);
	}

	/**
	 * Stops `config`'s worker, runs its `dependsOn.run` hook to completion (if set), and forks a
	 * fresh worker for it - then cascades to whatever depends on `config` in turn. Left stopped,
	 * with an error logged, if the hook keeps failing after its retries are exhausted.
	 */
	async function restartDependent(config: ProcessConfig): Promise<void> {
		if (shuttingDown || restarting.has(config.name)) return;
		restarting.add(config.name);
		try {
			const current = children.get(config.name);
			if (current) await stopChild(current);
			if (shuttingDown) return;

			const hook = config.dependsOn?.run;
			if (hook) {
				const ok = await runHookWithRetries(config.name, hook);
				if (!ok) {
					process.stderr.write(
						`[braid] "${config.name}": dependency hook "${hook.command}" kept failing; leaving it stopped\n`,
					);
					return;
				}
			}
			if (shuttingDown) return;

			spawnWorker(config);
			rewritePidfile();
			onProcessRestarted(config.name);
		} finally {
			restarting.delete(config.name);
			// A permanently-failed hook can leave this the last worker standing; re-check now that
			// it's no longer blocking shutdownIfEveryWorkerIsDone's restarting.size guard.
			shutdownIfEveryWorkerIsDone();
		}
	}

	function onProcessRestarted(name: string): void {
		for (const dependent of dependentsByTrigger.get(name) ?? []) {
			void restartDependent(dependent);
		}
	}

	for (const config of configs) {
		spawnWorker(config);
	}

	rewritePidfile();
	options.onReady?.();

	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);

	return exitPromise;
}
