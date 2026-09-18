#!/usr/bin/env node
import { fork } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	findRunningPidfile,
	runManager,
	statusFromPidfile,
	stopFromPidfile,
} from "./manager.js";
import { siblingModulePath, sourceExecArgv } from "./module-path.js";
import { braidTag } from "./prefix.js";
import type {
	BraidConfig,
	DaemonHandshakeMessage,
	Pidfile,
	ProcessConfig,
} from "./types.js";

const DAEMON_PATH = siblingModulePath(import.meta.url, "daemon");
// How long `start` waits for the daemon to confirm it's up before giving up.
const DAEMON_READY_TIMEOUT_MS = 5000;

export const DEFAULT_CONFIG_FILENAME = "braid.config.ts";
export const DEFAULT_PIDFILE_PATH = join(".braid", "run.json");

export type ParsedArgs = {
	command: string | undefined;
	configPath: string;
	/** Positional process name, used by `logs`. */
	processName?: string;
	follow: boolean;
	lines?: number;
	/** `start`'s foreground/daemon override: undefined defers to the config's `foreground` option. */
	foreground?: boolean;
	/** `start` only: ignore every process's `watch`/`beforeRestart` for this run. @default false */
	noWatch: boolean;
	/** `status`/`logs` only: machine-readable output instead of the default human-readable text. */
	json: boolean;
};

export function parseArgs(argv: string[], cwd: string): ParsedArgs {
	const [command, ...rest] = argv;
	let configPath = DEFAULT_CONFIG_FILENAME;
	let processName: string | undefined;
	let follow = false;
	let lines: number | undefined;
	let foreground: boolean | undefined;
	let noWatch = false;
	let json = false;

	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (arg === "--config") {
			const value = rest[i + 1];
			if (!value) throw new Error("--config requires a path");
			configPath = value;
			i++;
		} else if (arg === "--follow") {
			follow = true;
		} else if (arg === "--lines") {
			const value = rest[i + 1];
			const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
			if (!value || !Number.isFinite(parsed) || parsed <= 0) {
				throw new Error("--lines requires a positive number");
			}
			lines = parsed;
			i++;
		} else if (arg === "--foreground" || arg === "--daemon") {
			if (foreground !== undefined) {
				throw new Error("--foreground and --daemon are mutually exclusive");
			}
			foreground = arg === "--foreground";
		} else if (arg === "--no-watch") {
			noWatch = true;
		} else if (arg === "--json") {
			json = true;
		} else if (!arg?.startsWith("--") && processName === undefined) {
			processName = arg;
		}
	}
	return {
		command,
		configPath: resolve(cwd, configPath),
		processName,
		follow,
		lines,
		foreground,
		noWatch,
		json,
	};
}

/** Builds an `/api/...` URL against a running daemon's own control server. */
function controlUrl(
	pidfile: Pidfile,
	path: string,
	params?: Record<string, string>,
): URL {
	const url = new URL(`http://127.0.0.1:${pidfile.controlPort}${path}`);
	for (const [key, value] of Object.entries(params ?? {})) {
		url.searchParams.set(key, value);
	}
	return url;
}

/** fetch() against the control server, with its bearer token attached. */
function controlFetch(
	pidfile: Pidfile,
	url: URL,
	init?: RequestInit,
): Promise<Response> {
	return fetch(url, {
		...init,
		headers: {
			...init?.headers,
			Authorization: `Bearer ${pidfile.controlToken}`,
		},
	});
}

const CONFIG_SHAPE_ERROR = (configPath: string): string =>
	`braid config at ${configPath} must default-export a non-empty array or a { processes } object`;

/** Normalizes a config file's default export to a BraidConfig. */
/**
 * Throws a clear, per-entry message if any process config is missing the two fields every
 * downstream consumer (spawnWorker, the pidfile, the per-process log file) assumes are present -
 * without this, a config typo (a missing `command`, a `name` left as `undefined`) only surfaced
 * as an obscure runtime error inside a freshly-forked worker, well after the config had already
 * been accepted and other processes had already started.
 */
function validateProcessConfigShapes(
	processes: unknown[],
	configPath: string,
): asserts processes is ProcessConfig[] {
	processes.forEach((entry, index) => {
		if (!entry || typeof entry !== "object") {
			throw new Error(
				`braid config at ${configPath}: processes[${index}] must be an object`,
			);
		}
		const { name, command } = entry as Record<string, unknown>;
		if (typeof name !== "string" || name.length === 0) {
			throw new Error(
				`braid config at ${configPath}: processes[${index}] is missing a "name" string`,
			);
		}
		if (typeof command !== "string" || command.length === 0) {
			throw new Error(
				`braid config at ${configPath}: process "${name}" is missing a "command" string`,
			);
		}
	});
}

export async function loadConfig(configPath: string): Promise<BraidConfig> {
	if (!existsSync(configPath)) {
		throw new Error(`braid config not found at ${configPath}`);
	}
	let mod: { default?: unknown };
	try {
		mod = (await import(pathToFileURL(configPath).href)) as {
			default?: unknown;
		};
	} catch (error) {
		throw new Error(
			`braid: failed to load config at ${configPath}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	const exported = mod.default;

	if (Array.isArray(exported)) {
		if (exported.length === 0) {
			throw new Error(CONFIG_SHAPE_ERROR(configPath));
		}
		validateProcessConfigShapes(exported, configPath);
		return { processes: exported };
	}

	if (exported && typeof exported === "object") {
		const { processes, plugins, logs, foreground, statsPollIntervalMs } =
			exported as Partial<BraidConfig>;
		if (!Array.isArray(processes) || processes.length === 0) {
			throw new Error(CONFIG_SHAPE_ERROR(configPath));
		}
		if (plugins !== undefined && !Array.isArray(plugins)) {
			throw new Error(
				`braid config at ${configPath}'s "plugins" must be an array`,
			);
		}
		validateProcessConfigShapes(processes, configPath);
		return {
			processes,
			plugins,
			logs,
			foreground,
			statsPollIntervalMs,
		};
	}

	throw new Error(CONFIG_SHAPE_ERROR(configPath));
}

/**
 * Strips `watch`/`beforeRestart` from every process config for this run only - the config file on
 * disk is untouched. `beforeRestart` is dropped alongside `watch` (not left in place) since it only
 * ever fires from inside a watch-triggered restart (see manager.ts's own "sets beforeRestart but no
 * watch paths" startup validation) - leaving it set with `watch` gone would trip that same check.
 * Logs which process names were affected so the divergence from the config file isn't silent.
 */
export function applyNoWatch(config: BraidConfig): BraidConfig {
	const affected: string[] = [];
	const processes = config.processes.map((process) => {
		if (!process.watch?.length && !process.beforeRestart) return process;
		affected.push(process.name);
		const { watch, beforeRestart, ...rest } = process;
		return rest;
	});
	if (affected.length > 0) {
		console.log(
			`${braidTag()} --no-watch set; ignoring watch/beforeRestart for: ${affected.join(", ")}`,
		);
	}
	return { ...config, processes };
}

type DaemonStartOutcome =
	| {
			ok: true;
			pid: number;
			/** A plugin's own pre-ready `ctx.log()` lines (see `DaemonHandshakeMessage`'s "log"
			 *  variant), e.g. the ui-plugin's dashboard URL. Buffered rather than printed as they
			 *  arrive, so the caller can flush them *after* the startup summary table - matching the
			 *  roadmap's intended ordering, since these otherwise arrive before "ready" and so before
			 *  the table has anything to print. */
			logLines: string[];
	  }
	| { ok: false; message: string };

/** Forks daemon.ts detached (stdout/stderr to daemon.log), then races its ready/error IPC message.
 *  Exported (mirroring `worker.ts`/`daemon.ts`'s own exports) so `startDaemon.spec.ts` can drive
 *  the ready/error/exit/fork-error/timeout race directly, with `node:child_process`'s `fork`
 *  mocked - those outcomes are all rare-failure-mode/timing paths that a real forked daemon can't
 *  be made to hit deterministically from a test. */
export async function startDaemon(
	config: BraidConfig,
	configPath: string,
	pidfilePath: string,
	cwd: string,
): Promise<DaemonStartOutcome> {
	const braidDir = dirname(pidfilePath);
	// mode: 0o700 - this directory ends up holding the pidfile's control-server bearer token (see
	// manager.ts's own matching mkdirSync/chmodSync), and this is the first thing to create it in
	// the real (daemonized) `braid start` path, ahead of the daemon process itself even forking.
	mkdirSync(braidDir, { recursive: true, mode: 0o700 });
	const daemonLogPath = join(braidDir, "daemon.log");
	if (existsSync(daemonLogPath)) {
		renameSync(daemonLogPath, `${daemonLogPath}.1`);
	}
	const daemonLogFd = openSync(daemonLogPath, "a", 0o600);

	const daemonInput = {
		processes: config.processes,
		plugins: config.plugins,
		configPath,
		logs: config.logs,
		statsPollIntervalMs: config.statsPollIntervalMs,
		pidfilePath,
	};

	const child = fork(DAEMON_PATH, [], {
		cwd,
		detached: true,
		stdio: ["ignore", daemonLogFd, daemonLogFd, "ipc"],
		env: { ...process.env, BRAID_DAEMON_INPUT: JSON.stringify(daemonInput) },
		execArgv: sourceExecArgv(import.meta.url),
	});
	closeSync(daemonLogFd);

	const outcome = await new Promise<DaemonStartOutcome>((settle) => {
		const timeout = setTimeout(() => {
			cleanup();
			settle({
				ok: false,
				message: `daemon (pid ${child.pid}) did not confirm startup within ${DAEMON_READY_TIMEOUT_MS}ms; check ${daemonLogPath}`,
			});
		}, DAEMON_READY_TIMEOUT_MS);

		function cleanup(): void {
			clearTimeout(timeout);
			child.off("message", onMessage);
			child.off("exit", onExit);
			child.off("error", onError);
		}

		// Buffered rather than printed immediately - see `DaemonStartOutcome.logLines`'s own doc
		// comment for why.
		const logLines: string[] = [];

		// Not .once(): a plugin's own relayed "log" line (see PluginContext.log) can arrive before
		// the "ready"/"error" handshake message, and shouldn't be mistaken for it - only "ready"/
		// "error" settle and stop listening.
		function onMessage(message: DaemonHandshakeMessage): void {
			if (message.type === "log") {
				logLines.push(message.message);
				return;
			}
			cleanup();
			settle(
				message.type === "ready"
					? { ok: true, pid: child.pid as number, logLines }
					: { ok: false, message: message.message },
			);
		}
		function onExit(code: number | null): void {
			cleanup();
			settle({
				ok: false,
				message: `daemon exited before starting up (code ${code}); check ${daemonLogPath}`,
			});
		}
		function onError(error: Error): void {
			cleanup();
			settle({
				ok: false,
				message: `failed to start daemon: ${error.message}`,
			});
		}

		child.on("message", onMessage);
		child.once("exit", onExit);
		child.once("error", onError);
	});

	if (!outcome.ok) {
		try {
			const tail = readFileSync(daemonLogPath, "utf8")
				.split("\n")
				.slice(-20)
				.join("\n")
				.trim();
			if (tail) console.error(tail);
		} catch {
			// daemon.log may not exist yet if the fork itself failed - nothing to show.
		}
		try {
			child.disconnect();
		} catch {
			// already disconnected/exited
		}
		return outcome;
	}

	child.disconnect();
	child.unref();
	return outcome;
}

/** Streams a running manager's combined process output straight to this terminal until it shuts down. */
export async function followLogs(pidfile: Pidfile): Promise<void> {
	const url = controlUrl(pidfile, "/api/logs", { follow: "true" });
	let response: Response;
	try {
		response = await controlFetch(pidfile, url);
	} catch {
		// Couldn't even connect - the control server tearing down mid-shutdown looks the same as a
		// real connection failure here, so this stays silent like the streaming errors below do.
		return;
	}
	if (!response.ok) {
		console.error(
			`${braidTag()} logs: ${response.status} ${await response.text()}`,
		);
		return;
	}
	if (!response.body) return;
	try {
		for await (const chunk of response.body) {
			process.stdout.write(chunk);
		}
	} catch {
		// The control server tears down mid-stream on shutdown - nothing left to report.
	}
}

/** Matches what `PluginContext.getProcesses()` (and so `GET /api/status`) returns per process. */
type LiveProcessStatus = {
	name: string;
	pid: number | undefined;
	alive: boolean;
	/** Absent for a configured process that has never been started (`autoStart: false`). */
	startedAt?: string;
	cpu?: number;
	memory?: number;
	/** Absent when falling back to the plain pidfile (no live daemon to ask) - only known in-memory. */
	restartCount?: number;
	/** This process's own `ProcessConfig.url`, if it set one. Purely informational. */
	url?: string;
};

function formatBytes(bytes: number): string {
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatUptime(startedAt: string): string {
	const totalSeconds = Math.max(
		0,
		Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000),
	);
	const days = Math.floor(totalSeconds / 86400);
	const hours = Math.floor((totalSeconds % 86400) / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${minutes}m`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

type StartupSummaryRow = {
	name: string;
	pid: number | undefined;
	alive: boolean;
	url?: string;
};

/** Prints the one-time post-`start` summary block: a header ("N processes running") and one line
 *  per configured process, sorted by name for a stable, scannable order (matching every other
 *  process listing in this file). Shared between `start`'s foreground and daemonized paths - the
 *  only difference between them is where `rows`/`managerPid` come from. */
function printStartupSummary(
	managerPid: number,
	rows: StartupSummaryRow[],
): void {
	const aliveCount = rows.filter((row) => row.alive).length;
	console.log(
		`${braidTag()} ${aliveCount} process${aliveCount === 1 ? "" : "es"} running (pid ${managerPid})`,
	);
	for (const row of [...rows].sort((a, b) => a.name.localeCompare(b.name))) {
		const parts = [`  ${row.alive ? "●" : "○"} ${row.name}`];
		if (row.url) parts.push(row.url);
		if (row.pid !== undefined) parts.push(`pid ${row.pid}`);
		console.log(parts.join("  "));
	}
}

/**
 * Fetches live cpu/memory-enriched status straight from the running daemon's own `/api/status`
 * (the same route the dashboard polls). Returns `undefined` on any failure - network error,
 * non-200 (including a stale-token 401, collapsed into the same fallback here: a much tighter
 * race for a short-lived CLI process re-reading the pidfile fresh each invocation than the
 * browser's stale-long-session case, so distinct messaging isn't worth building for this path) -
 * so the caller can fall back to today's pidfile-only status with no cpu/memory.
 */
async function fetchLiveStatus(
	pidfile: Pidfile,
): Promise<LiveProcessStatus[] | undefined> {
	try {
		const response = await controlFetch(
			pidfile,
			controlUrl(pidfile, "/api/status"),
		);
		if (!response.ok) return undefined;
		return (await response.json()) as LiveProcessStatus[];
	} catch {
		return undefined;
	}
}

/**
 * Calls the running daemon's per-process stop/restart route for `name`. Unlike bare `stop`
 * (which falls back to killing PIDs straight from the pidfile), there's no fallback here - a
 * per-name operation needs the manager's own in-process state (dependents, in-flight guards),
 * not just a PID to signal - so an unreachable daemon is reported as a clear failure instead.
 */
async function postProcessAction(
	pidfile: Pidfile,
	action: "stop" | "restart" | "start",
	name: string,
): Promise<{ ok: boolean; message: string }> {
	const url = controlUrl(pidfile, `/api/processes/${action}`, { name });
	try {
		const response = await controlFetch(pidfile, url, { method: "POST" });
		const text = (await response.text()).trim();
		return {
			ok: response.ok,
			message: text || `HTTP ${response.status}`,
		};
	} catch (error) {
		return {
			ok: false,
			message: `couldn't reach the running daemon's control server (it may have crashed) - ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
}

/**
 * Runs every configured process attached to this terminal instead of forking a background daemon.
 * Ctrl-C is handled by runManager's own SIGINT listener, which stops every process before this
 * resolves.
 */
async function runForeground(
	config: BraidConfig,
	configPath: string,
	pidfilePath: string,
	cwd: string,
): Promise<number> {
	let following: Promise<void> | undefined;
	const exitCode = await runManager(config.processes, pidfilePath, {
		plugins: config.plugins,
		configPath,
		logs: config.logs,
		statsPollIntervalMs: config.statsPollIntervalMs,
		cwd,
		onReady: (workers) => {
			printStartupSummary(process.pid, workers);
			console.log(`${braidTag()} running in foreground. Press Ctrl-C to stop.`);
			const running = findRunningPidfile(pidfilePath);
			// istanbul ignore else -- `running` is only ever falsy here if something outside braid
			// deletes/corrupts the pidfile in the zero-yield-point window between manager.ts's own
			// rewritePidfile() (immediately before onReady fires) and this callback running - not a
			// reachable case to simulate from a test without literally racing the filesystem.
			if (running) following = followLogs(running);
		},
	});
	await following;
	return exitCode;
}

type StartCommandArgs = {
	processName: string | undefined;
	pidfilePath: string;
	configPath: string;
	noWatch: boolean;
	foreground: boolean | undefined;
	cwd: string;
};

/**
 * Handles `braid start [name]`. The per-process form (`braid start <name>`) starts one configured
 * process - most useful for an `autoStart: false` one - inside an already-running daemon, checked
 * before the whole-stack "already running" guard below since it requires the opposite
 * precondition: a live daemon, not the absence of one.
 */
async function runStartCommand({
	processName,
	pidfilePath,
	configPath,
	noWatch,
	foreground,
	cwd,
}: StartCommandArgs): Promise<number> {
	if (processName) {
		const running = findRunningPidfile(pidfilePath);
		if (!running) {
			console.log("Nothing running.");
			return 0;
		}
		const { ok, message } = await postProcessAction(
			running,
			"start",
			processName,
		);
		console.log(ok ? `Started: ${processName}` : `${braidTag()} ${message}`);
		return ok ? 0 : 1;
	}
	const alreadyRunning = findRunningPidfile(pidfilePath);
	if (alreadyRunning) {
		console.error(
			`braid already running (pid ${alreadyRunning.managerPid}). Run "stop" first, or delete ${pidfilePath} if that's stale.`,
		);
		return 1;
	}
	const loadedConfig = await loadConfig(configPath);
	const config = noWatch ? applyNoWatch(loadedConfig) : loadedConfig;
	const runInForeground = foreground ?? config.foreground ?? false;
	if (runInForeground) {
		return runForeground(config, configPath, pidfilePath, cwd);
	}
	const outcome = await startDaemon(config, configPath, pidfilePath, cwd);
	if (!outcome.ok) {
		console.error(`${braidTag()} ${outcome.message}`);
		return 1;
	}
	const running = findRunningPidfile(pidfilePath);
	// istanbul ignore next -- the control server has already completed a "ready" handshake by this
	// point (controlServerReady fires well before it), so `running` coming back undefined, or the
	// live fetch itself failing, would mean the daemon crashed in the handful of ms since - not
	// reachable from a test without literally racing that window. Falls back to the pidfile's own
	// name/pid/alive (no url: that only comes from live config the pidfile doesn't carry) rather
	// than failing `start` itself over a display line.
	const rows: StartupSummaryRow[] =
		(running && (await fetchLiveStatus(running))) ||
		statusFromPidfile(pidfilePath).map(({ name, pid, alive }) => ({
			name,
			pid,
			alive,
		}));
	printStartupSummary(outcome.pid, rows);
	for (const line of outcome.logLines) console.log(line);
	return 0;
}

type LogsCommandArgs = {
	pidfilePath: string;
	processName: string | undefined;
	follow: boolean;
	lines: number | undefined;
	json: boolean;
};

/** Handles `braid logs [name]`, streaming a running daemon's `/api/logs` straight to this terminal. */
async function runLogsCommand({
	pidfilePath,
	processName,
	follow,
	lines,
	json,
}: LogsCommandArgs): Promise<number> {
	const running = findRunningPidfile(pidfilePath);
	if (!running) {
		console.log("Nothing running.");
		return 0;
	}
	const url = controlUrl(running, "/api/logs", {
		...(processName ? { name: processName } : {}),
		...(follow ? { follow: "true" } : {}),
		...(lines !== undefined ? { lines: String(lines) } : {}),
		...(json ? { json: "true" } : {}),
	});

	// Handle both: Ctrl-C sends SIGINT, but pnpm re-sends interruption as SIGTERM.
	const controller = new AbortController();
	const onSignal = () => controller.abort();
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	try {
		const response = await controlFetch(running, url, {
			signal: controller.signal,
		});
		if (!response.ok) {
			console.error(
				`${braidTag()} ${response.status} ${await response.text()}`,
			);
			return 1;
		}
		if (response.body) {
			for await (const chunk of response.body) {
				process.stdout.write(chunk);
			}
		}
		return 0;
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") return 0;
		throw error;
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
	}
}

type StopCommandArgs = {
	pidfilePath: string;
	processName: string | undefined;
};

/** Handles `braid stop [name]`. */
async function runStopCommand({
	pidfilePath,
	processName,
}: StopCommandArgs): Promise<number> {
	if (processName) {
		const running = findRunningPidfile(pidfilePath);
		if (!running) {
			console.log("Nothing running.");
			return 0;
		}
		const { ok, message } = await postProcessAction(
			running,
			"stop",
			processName,
		);
		console.log(ok ? `Stopped: ${processName}` : `${braidTag()} ${message}`);
		return ok ? 0 : 1;
	}
	const stopped = await stopFromPidfile(pidfilePath);
	console.log(
		stopped.length > 0 ? `Stopped: ${stopped.join(", ")}` : "Nothing running.",
	);
	return 0;
}

type RestartCommandArgs = {
	pidfilePath: string;
	processName: string | undefined;
};

/** Handles `braid restart <name>`. Unlike `start`/`stop`, the name is required - there's no
 *  whole-stack meaning for "restart everything". */
async function runRestartCommand({
	pidfilePath,
	processName,
}: RestartCommandArgs): Promise<number> {
	if (!processName) {
		console.error("Usage: braid restart <name> [--config <path>]");
		return 1;
	}
	const running = findRunningPidfile(pidfilePath);
	if (!running) {
		console.log("Nothing running.");
		return 0;
	}
	const { ok, message } = await postProcessAction(
		running,
		"restart",
		processName,
	);
	console.log(ok ? `Restarted: ${processName}` : `${braidTag()} ${message}`);
	return ok ? 0 : 1;
}

/**
 * Handles `braid status`. Not gated on `findRunningPidfile` the way stop/restart are: that returns
 * undefined for a stale-but-present pidfile (every pid dead) too, and today's "show stopped
 * workers" behavior below depends on `statusFromPidfile`'s own result length deciding "Nothing
 * running.", not a separate liveness check - gating the whole command on it would regress that
 * case. `findRunningPidfile` is only used here to decide whether it's worth trying to reach a
 * daemon at all.
 */
async function runStatusCommand(
	pidfilePath: string,
	json: boolean,
): Promise<number> {
	const running = findRunningPidfile(pidfilePath);
	const live = running ? await fetchLiveStatus(running) : undefined;
	const statuses: LiveProcessStatus[] = live ?? statusFromPidfile(pidfilePath);
	if (json) {
		console.log(JSON.stringify(statuses));
		return 0;
	}
	if (statuses.length === 0) {
		console.log("Nothing running.");
		return 0;
	}
	for (const status of statuses) {
		// A configured process that's never been started (autoStart: false, not yet manually
		// started) has no pid/startedAt at all - distinct from "stopped", which means it ran
		// before and has since exited.
		if (status.pid === undefined) {
			console.log(`○ ${status.name}  not started`);
			continue;
		}
		const stats =
			status.cpu !== undefined && status.memory !== undefined
				? `  cpu ${status.cpu.toFixed(1)}%  mem ${formatBytes(status.memory)}`
				: "";
		const restarts =
			status.restartCount !== undefined
				? `  restarts ${status.restartCount}`
				: "";
		const uptime =
			status.alive && status.startedAt
				? `  up ${formatUptime(status.startedAt)}`
				: "";
		console.log(
			`${status.alive ? "●" : "○"} ${status.name}  pid ${status.pid}  ${status.alive ? "running" : "stopped"}${stats}${restarts}${uptime}`,
		);
	}
	return 0;
}

function printUsage(): void {
	console.error(
		"Usage: braid <start [name]|stop [name]|restart <name>|status|logs [name]> [--config <path>] [--follow] [--lines <n>] [--foreground|--daemon] [--no-watch] [--json]",
	);
}

export async function runCli(argv: string[], cwd: string): Promise<number> {
	const {
		command,
		configPath,
		processName,
		follow,
		lines,
		foreground,
		noWatch,
		json,
	} = parseArgs(argv, cwd);
	const pidfilePath = resolve(cwd, DEFAULT_PIDFILE_PATH);

	switch (command) {
		case "start":
			return runStartCommand({
				processName,
				pidfilePath,
				configPath,
				noWatch,
				foreground,
				cwd,
			});
		case "logs":
			return runLogsCommand({ pidfilePath, processName, follow, lines, json });
		case "stop":
			return runStopCommand({ pidfilePath, processName });
		case "restart":
			return runRestartCommand({ pidfilePath, processName });
		case "status":
			return runStatusCommand(pidfilePath, json);
		default:
			printUsage();
			return 1;
	}
}

// Compares realpaths: process.argv[1] is a symlink for an installed bin, import.meta.url isn't.
export function isMainModule(
	argv1: string | undefined,
	moduleUrl: string,
): boolean {
	if (!argv1) return false;
	try {
		return moduleUrl === pathToFileURL(realpathSync(argv1)).href;
	} catch {
		return false;
	}
}

/* istanbul ignore next -- thin process entrypoint, exercised via runCli's own tests instead */
if (isMainModule(process.argv[1], import.meta.url)) {
	runCli(process.argv.slice(2), process.cwd())
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error: unknown) => {
			console.error(error instanceof Error ? error.message : error);
			process.exitCode = 1;
		});
}
