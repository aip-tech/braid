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
import { linePrefixer } from "./prefix.js";
import type {
	BraidConfig,
	Pidfile,
	PidfileWorker,
	PluginConfigEntry,
	ProcessConfig,
	RestartHook,
	WorkerStatusMessage,
} from "./types.js";

const WORKER_PATH = siblingModulePath(import.meta.url, "worker");

// How long shutdown() waits for daemonShutdown listeners before proceeding regardless.
const SHUTDOWN_EVENT_TIMEOUT_MS = 2000;

const DEFAULT_HOOK_RETRIES = 5;
const DEFAULT_HOOK_RETRY_DELAY_MS = 1000;
const DEFAULT_READY_TIMEOUT_MS = 10_000;
// Bounds the rolling buffer readyPattern is tested against, so a chatty process before it's
// actually ready can't grow this without bound while still letting a match span two chunks.
const READY_PATTERN_BUFFER_BYTES = 8192;

export type RunManagerOptions = {
	/** External plugins to load, resolved relative to configPath. */
	plugins?: PluginConfigEntry[];
	/** The config file plugin specifiers are resolved against. Required if `plugins` is non-empty. */
	configPath?: string;
	/** Per-process log file settings, forwarded to the core logger plugin. */
	logs?: BraidConfig["logs"];
	/**
	 * Base directory each config's own relative `cwd` (and restart hooks' `cwd`) is resolved
	 * against. @default process.cwd() - only needs overriding when the caller runs in-process
	 * (e.g. a foreground `start`) rather than as a daemon already forked into the right directory.
	 */
	cwd?: string;
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

/** Guards against any stray IPC message that isn't braid's own worker->manager protocol. */
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
	for (const config of configs) {
		if (config.beforeRestart && !(config.watch && config.watch.length > 0)) {
			throw new Error(
				`braid: process "${config.name}" sets "beforeRestart" but no "watch" paths - nothing would ever trigger it`,
			);
		}
	}
	const baseCwd = options.cwd ?? process.cwd();
	const configsByName = new Map(configs.map((config) => [config.name, config]));

	mkdirSync(dirname(pidfilePath), { recursive: true });
	const logsDir = options.logs?.dir ?? join(dirname(pidfilePath), "logs");

	const children = new Map<string, ChildProcess>();
	// One-off `dependsOn.run` hook processes currently in flight, so shutdown can kill them too.
	const hookChildren = new Set<ChildProcess>();
	const pidfileWorkers: PidfileWorker[] = [];
	// Dependent names currently mid stop/hook/restart cycle, so an overlapping trigger is skipped.
	const restarting = new Set<string>();
	// Process names whose "restart" message has fired but whose matching "started" hasn't yet -
	// onRestart/dependsOn cascades wait here, rather than on "restart" itself, see handleFreshStart.
	const awaitingFreshStart = new Set<string>();
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

	/**
	 * `crashedName`, when given, is the process whose own crash triggered this shutdown - excluded
	 * from the "stopping" note below since braid didn't stop it, it crashed on its own. A liveness
	 * check alone isn't enough to tell the two apart: a process that just called `process.exit()`
	 * can still pass `isAlive` (a zombie until reaped) or show `exitCode === null` on its own
	 * ChildProcess object for a moment (the crash IPC message can arrive before the manager's own
	 * "exit" event for it does).
	 */
	const shutdown = async (
		code: number,
		crashedName?: string,
	): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		exitCode = code;
		// Deliberately NOT removed here: a graceful shutdown with several processes to tree-kill
		// can take a moment, and a second SIGINT/SIGTERM in that window (an impatient repeat
		// Ctrl-C, or some terminals/shells delivering it twice) needs to land on this same
		// listener and no-op via the guard above - otherwise, with no listener left, Node's
		// default disposition kills the process immediately via the raw signal, truncating
		// whatever was still in flight (mid-tree-kill children, unflushed log/log-follow output)
		// and reporting a signal-based failure to whatever launched it (e.g. pnpm).

		// Logged before daemonShutdown (below) closes every log stream - writing to one after
		// that point throws (SonicBoom destroyed).
		for (const [name, child] of children) {
			if (
				name !== crashedName &&
				typeof child.pid === "number" &&
				isAlive(child.pid)
			) {
				const config = configsByName.get(name);
				if (config) logToProcess(config, "stopping");
			}
		}

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
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		resolveExitPromise(exitCode);
	};

	/**
	 * Runs a restart hook once, its output line-prefixed with `logName` (the owning process's own
	 * name) the same way a regular process's output is, and folded into that same log; resolves
	 * true on a zero exit code.
	 */
	function runHookOnce(
		logName: string,
		color: string | undefined,
		hook: RestartHook,
	): Promise<boolean> {
		return new Promise((resolve) => {
			const emitOutput = (stream: "stdout" | "stderr", line: string) =>
				void safeEmit(emitter, "processOutput", {
					type: "processOutput",
					name: logName,
					stream,
					chunk: Buffer.from(line),
				});
			const stdoutPrefixer = linePrefixer(
				(line) => emitOutput("stdout", line),
				logName,
				color,
			);
			const stderrPrefixer = linePrefixer(
				(line) => emitOutput("stderr", line),
				logName,
				color,
			);

			const hookChild = spawn(hook.command, hook.args ?? [], {
				cwd: hook.cwd ? join(baseCwd, hook.cwd) : baseCwd,
				env: process.env,
			});
			hookChildren.add(hookChild);
			hookChild.stdout?.on("data", (chunk: Buffer) =>
				stdoutPrefixer.write(chunk),
			);
			hookChild.stderr?.on("data", (chunk: Buffer) =>
				stderrPrefixer.write(chunk),
			);
			hookChild.on("exit", (code) => {
				stdoutPrefixer.flush();
				stderrPrefixer.flush();
				hookChildren.delete(hookChild);
				resolve(code === 0);
			});
			hookChild.on("error", () => {
				stdoutPrefixer.flush();
				stderrPrefixer.flush();
				hookChildren.delete(hookChild);
				resolve(false);
			});
		});
	}

	/** Retries a restart hook, since whatever it needs (a dependency, a build) may still be catching up. */
	async function runHookWithRetries(
		logName: string,
		color: string | undefined,
		hook: RestartHook,
	): Promise<boolean> {
		const retries = hook.retries ?? DEFAULT_HOOK_RETRIES;
		const retryDelayMs = hook.retryDelayMs ?? DEFAULT_HOOK_RETRY_DELAY_MS;
		for (let attempt = 0; attempt <= retries; attempt++) {
			if (shuttingDown) return false;
			if (await runHookOnce(logName, color, hook)) return true;
			if (attempt < retries) await delay(retryDelayMs);
		}
		return false;
	}

	/** Writes `message` into `config`'s own log only, prefixed the same way its output already is. */
	function logToProcess(config: ProcessConfig, message: string): void {
		const prefixer = linePrefixer(
			(line) =>
				void safeEmit(emitter, "processOutput", {
					type: "processOutput",
					name: config.name,
					stream: "stderr",
					chunk: Buffer.from(line),
				}),
			config.name,
			config.color,
		);
		prefixer.write(`braid: ${message}`);
		prefixer.flush();
	}

	/**
	 * Writes a dependsOn/onRestart/readyPattern diagnostic both to `.braid/daemon.log` (as before)
	 * and into `config`'s own log (via `logToProcess`) - otherwise these only ever showed up in
	 * daemon.log, invisible to anyone just running `braid logs --follow`.
	 */
	function emitDiagnostic(config: ProcessConfig, message: string): void {
		process.stderr.write(`[braid] "${config.name}": ${message}\n`);
		logToProcess(config, message);
	}

	function spawnWorker(config: ProcessConfig): void {
		const child = fork(WORKER_PATH, [], {
			cwd: config.cwd ? join(baseCwd, config.cwd) : baseCwd,
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
			if (!isWorkerStatusMessage(message)) return;
			if (message.type === "restart") {
				void safeEmit(emitter, "processRestart", {
					type: "processRestart",
					name: config.name,
				});
				// Don't run onRestart/dependsOn hooks yet - the worker sends this the moment it
				// decides to restart, before the old process is even dead, let alone the new one
				// ready. Wait for the matching "started" message instead (see below).
				awaitingFreshStart.add(config.name);
				return;
			}
			if (message.type === "started") {
				// Also fires at initial start, with no preceding "restart" - nothing to do then.
				if (awaitingFreshStart.delete(config.name)) {
					void handleFreshStart(config);
				}
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
				void shutdown(1, config.name);
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
				void shutdown(1, config.name);
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
			if (current) {
				logToProcess(config, "stopping (dependency restarted)");
				await stopChild(current);
			}
			if (shuttingDown) return;

			const hook = config.dependsOn?.run;
			if (hook) {
				const ok = await runHookWithRetries(config.name, config.color, hook);
				if (!ok) {
					emitDiagnostic(
						config,
						`dependency hook "${hook.command}" kept failing; leaving it stopped`,
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

	/** Resolves once `pattern` matches `name`'s accumulated stdout/stderr, or `timeoutMs` elapses. */
	function waitForReadyPattern(
		name: string,
		pattern: RegExp,
		timeoutMs: number,
	): Promise<boolean> {
		return new Promise((resolve) => {
			let buffer = "";
			let settled = false;
			const onOutput = (event: {
				type: string;
				name: string;
				chunk: Buffer;
			}) => {
				if (event.type !== "processOutput" || event.name !== name) return;
				buffer = (buffer + event.chunk.toString()).slice(
					-READY_PATTERN_BUFFER_BYTES,
				);
				if (pattern.test(buffer)) settle(true);
			};
			const settle = (ready: boolean) => {
				if (settled) return;
				settled = true;
				emitter.off("processOutput", onOutput);
				clearTimeout(timer);
				resolve(ready);
			};
			emitter.on("processOutput", onOutput);
			const timer = setTimeout(() => settle(false), timeoutMs);
		});
	}

	/**
	 * Runs once `config`'s process has actually (re)spawned after a restart (not merely once the
	 * worker decided to restart it - see the "started" branch above): waits for `readyPattern` (if
	 * set), then runs its own `onRestart` hook (if set), then notifies dependents. Skipped if the
	 * hook keeps failing, since a dependent's own hook would otherwise run against whatever the
	 * failed hook was supposed to freshen up. A `readyPattern` that never matches is logged and
	 * treated as "proceed anyway" - it's a best-effort signal, not a hard gate.
	 */
	async function handleFreshStart(config: ProcessConfig): Promise<void> {
		if (shuttingDown) return;
		if (config.readyPattern) {
			const timeoutMs = config.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
			const ready = await waitForReadyPattern(
				config.name,
				new RegExp(config.readyPattern),
				timeoutMs,
			);
			if (!ready) {
				emitDiagnostic(
					config,
					`readyPattern never matched within ${timeoutMs}ms; proceeding anyway`,
				);
			}
			if (shuttingDown) return;
		}

		const hook = config.onRestart;
		if (!hook) {
			onProcessRestarted(config.name);
			return;
		}
		// Shares `restarting` with restartDependent's dependent-keyed guard: both mean "don't
		// start another restart cycle for this same process name while one's already in flight."
		if (restarting.has(config.name)) return;
		restarting.add(config.name);
		try {
			const ok = await runHookWithRetries(config.name, config.color, hook);
			if (!ok) {
				emitDiagnostic(
					config,
					`onRestart hook "${hook.command}" kept failing; not notifying dependents`,
				);
				return;
			}
		} finally {
			restarting.delete(config.name);
			shutdownIfEveryWorkerIsDone();
		}
		onProcessRestarted(config.name);
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
