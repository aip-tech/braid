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
	statusFromPidfile,
	stopFromPidfile,
} from "./manager.js";
import { siblingModulePath, sourceExecArgv } from "./module-path.js";
import type {
	BraidConfig,
	DaemonHandshakeMessage,
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
};

export function parseArgs(argv: string[], cwd: string): ParsedArgs {
	const [command, ...rest] = argv;
	let configPath = DEFAULT_CONFIG_FILENAME;
	let processName: string | undefined;
	let follow = false;
	let lines: number | undefined;

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
	};
}

const CONFIG_SHAPE_ERROR = (configPath: string): string =>
	`braid config at ${configPath} must default-export a non-empty array or a { processes } object`;

/** Normalizes a config file's default export to a BraidConfig. */
export async function loadConfig(configPath: string): Promise<BraidConfig> {
	if (!existsSync(configPath)) {
		throw new Error(`braid config not found at ${configPath}`);
	}
	const mod = (await import(pathToFileURL(configPath).href)) as {
		default?: unknown;
	};
	const exported = mod.default;

	if (Array.isArray(exported)) {
		if (exported.length === 0) {
			throw new Error(CONFIG_SHAPE_ERROR(configPath));
		}
		return { processes: exported as ProcessConfig[] };
	}

	if (exported && typeof exported === "object") {
		const { processes, plugins } = exported as Partial<BraidConfig>;
		if (!Array.isArray(processes) || processes.length === 0) {
			throw new Error(CONFIG_SHAPE_ERROR(configPath));
		}
		if (plugins !== undefined && !Array.isArray(plugins)) {
			throw new Error(
				`braid config at ${configPath}'s "plugins" must be an array`,
			);
		}
		return { processes: processes as ProcessConfig[], plugins };
	}

	throw new Error(CONFIG_SHAPE_ERROR(configPath));
}

type DaemonStartOutcome =
	| { ok: true; pid: number }
	| { ok: false; message: string };

/** Forks daemon.ts detached (stdout/stderr to daemon.log), then races its ready/error IPC message. */
async function startDaemon(
	config: BraidConfig,
	configPath: string,
	pidfilePath: string,
	cwd: string,
): Promise<DaemonStartOutcome> {
	const braidDir = dirname(pidfilePath);
	mkdirSync(braidDir, { recursive: true });
	const daemonLogPath = join(braidDir, "daemon.log");
	if (existsSync(daemonLogPath)) {
		renameSync(daemonLogPath, `${daemonLogPath}.1`);
	}
	const daemonLogFd = openSync(daemonLogPath, "a");

	const daemonInput = {
		processes: config.processes,
		plugins: config.plugins,
		configPath,
		logs: config.logs,
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
			settle({
				ok: false,
				message: `daemon (pid ${child.pid}) did not confirm startup within ${DAEMON_READY_TIMEOUT_MS}ms; check ${daemonLogPath}`,
			});
		}, DAEMON_READY_TIMEOUT_MS);
		child.once("message", (message: DaemonHandshakeMessage) => {
			clearTimeout(timeout);
			settle(
				message.type === "ready"
					? { ok: true, pid: child.pid as number }
					: { ok: false, message: message.message },
			);
		});
		child.once("exit", (code) => {
			clearTimeout(timeout);
			settle({
				ok: false,
				message: `daemon exited before starting up (code ${code}); check ${daemonLogPath}`,
			});
		});
		child.once("error", (error) => {
			clearTimeout(timeout);
			settle({
				ok: false,
				message: `failed to start daemon: ${error.message}`,
			});
		});
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

export async function runCli(argv: string[], cwd: string): Promise<number> {
	const { command, configPath, processName, follow, lines } = parseArgs(
		argv,
		cwd,
	);
	const pidfilePath = resolve(cwd, DEFAULT_PIDFILE_PATH);

	switch (command) {
		case "start": {
			const alreadyRunning = findRunningPidfile(pidfilePath);
			if (alreadyRunning) {
				console.error(
					`braid already running (pid ${alreadyRunning.managerPid}). Run "stop" first, or delete ${pidfilePath} if that's stale.`,
				);
				return 1;
			}
			const config = await loadConfig(configPath);
			const outcome = await startDaemon(config, configPath, pidfilePath, cwd);
			if (!outcome.ok) {
				console.error(`braid: ${outcome.message}`);
				return 1;
			}
			console.log(`braid: started (pid ${outcome.pid})`);
			return 0;
		}
		case "logs": {
			const running = findRunningPidfile(pidfilePath);
			if (!running) {
				console.log("Nothing running.");
				return 0;
			}
			const url = new URL(`http://127.0.0.1:${running.controlPort}/api/logs`);
			if (processName) url.searchParams.set("name", processName);
			if (follow) url.searchParams.set("follow", "true");
			if (lines !== undefined) url.searchParams.set("lines", String(lines));

			// Handle both: Ctrl-C sends SIGINT, but pnpm re-sends interruption as SIGTERM.
			const controller = new AbortController();
			const onSignal = () => controller.abort();
			process.on("SIGINT", onSignal);
			process.on("SIGTERM", onSignal);
			try {
				const response = await fetch(url, {
					headers: { Authorization: `Bearer ${running.controlToken}` },
					signal: controller.signal,
				});
				if (!response.ok) {
					console.error(`braid: ${response.status} ${await response.text()}`);
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
		case "stop": {
			const stopped = await stopFromPidfile(pidfilePath);
			console.log(
				stopped.length > 0
					? `Stopped: ${stopped.join(", ")}`
					: "Nothing running.",
			);
			return 0;
		}
		case "status": {
			const statuses = statusFromPidfile(pidfilePath);
			if (statuses.length === 0) {
				console.log("Nothing running.");
				return 0;
			}
			for (const status of statuses) {
				console.log(
					`${status.alive ? "●" : "○"} ${status.name}  pid ${status.pid}  ${status.alive ? "running" : "stopped"}`,
				);
			}
			return 0;
		}
		default: {
			console.error(
				"Usage: braid <start|stop|status|logs [name]> [--config <path>] [--follow] [--lines <n>]",
			);
			return 1;
		}
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
