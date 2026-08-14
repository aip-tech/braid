import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	findRunningPidfile,
	runManager,
	statusFromPidfile,
	stopFromPidfile,
} from "./manager.js";
import type { ProcessConfig } from "./types.js";

export const DEFAULT_CONFIG_FILENAME = "process-manager.config.ts";
export const DEFAULT_PIDFILE_PATH = join(".process-manager", "run.json");

export type ParsedArgs = { command: string | undefined; configPath: string };

export function parseArgs(argv: string[], cwd: string): ParsedArgs {
	const [command, ...rest] = argv;
	let configPath = DEFAULT_CONFIG_FILENAME;
	for (let i = 0; i < rest.length; i++) {
		if (rest[i] === "--config") {
			const value = rest[i + 1];
			if (!value) throw new Error("--config requires a path");
			configPath = value;
			i++;
		}
	}
	return { command, configPath: resolve(cwd, configPath) };
}

export async function loadConfig(configPath: string): Promise<ProcessConfig[]> {
	if (!existsSync(configPath)) {
		throw new Error(`process-manager config not found at ${configPath}`);
	}
	const mod = (await import(pathToFileURL(configPath).href)) as {
		default?: unknown;
	};
	const config = mod.default;
	if (!Array.isArray(config) || config.length === 0) {
		throw new Error(
			`process-manager config at ${configPath} must default-export a non-empty array`,
		);
	}
	return config as ProcessConfig[];
}

export async function runCli(argv: string[], cwd: string): Promise<number> {
	const { command, configPath } = parseArgs(argv, cwd);
	const pidfilePath = resolve(cwd, DEFAULT_PIDFILE_PATH);

	switch (command) {
		case "start": {
			const alreadyRunning = findRunningPidfile(pidfilePath);
			if (alreadyRunning) {
				console.error(
					`process manager already running (pid ${alreadyRunning.managerPid}). Run "stop" first, or delete ${pidfilePath} if that's stale.`,
				);
				return 1;
			}
			const configs = await loadConfig(configPath);
			return runManager(configs, pidfilePath);
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
			console.error("Usage: sos-run <start|stop|status> [--config <path>]");
			return 1;
		}
	}
}

/* istanbul ignore next -- thin process entrypoint, exercised via runCli's own tests instead */
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	runCli(process.argv.slice(2), process.cwd())
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error: unknown) => {
			console.error(error instanceof Error ? error.message : error);
			process.exitCode = 1;
		});
}
