#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	findRunningPidfile,
	runManager,
	statusFromPidfile,
	stopFromPidfile,
} from "./manager.js";
import type { BraidConfig, ProcessConfig } from "./types.js";

export const DEFAULT_CONFIG_FILENAME = "braid.config.ts";
export const DEFAULT_PIDFILE_PATH = join(".braid", "run.json");

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

const CONFIG_SHAPE_ERROR = (configPath: string): string =>
	`braid config at ${configPath} must default-export a non-empty array or a { processes } object`;

/**
 * Normalizes a config file's default export to a BraidConfig. A bare
 * ProcessConfig[] (today's format) becomes { processes: [...] } with no
 * plugins; the object form additionally allows a `plugins` array.
 */
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

export async function runCli(argv: string[], cwd: string): Promise<number> {
	const { command, configPath } = parseArgs(argv, cwd);
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
			return runManager(config.processes, pidfilePath, {
				plugins: config.plugins,
				configPath,
			});
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
			console.error("Usage: braid <start|stop|status> [--config <path>]");
			return 1;
		}
	}
}

// Compares realpaths, not raw paths: when invoked through a package manager's bin symlink (the
// normal case for an installed CLI), process.argv[1] is the symlink path but import.meta.url
// reports the resolved target, so a naive comparison never matches and the CLI silently no-ops.
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
