import { runManager } from "./manager.js";
import { braidTag } from "./prefix.js";
import type {
	DaemonHandshakeMessage,
	PluginConfigEntry,
	ProcessConfig,
} from "./types.js";

type DaemonInput = {
	processes: ProcessConfig[];
	plugins?: PluginConfigEntry[];
	configPath?: string;
	logs?: { dir?: string; maxSizeBytes?: number };
	pidfilePath: string;
	statsPollIntervalMs?: number;
};

/** Reads and parses this fork's `BRAID_DAEMON_INPUT` env var - the daemon's whole config, passed
 *  by `cli.ts`'s `startDaemon` rather than re-read from disk (config files can be arbitrary JS/TS,
 *  not just data, so re-importing one from a different process/cwd isn't a safe substitute). */
export function loadInput(): DaemonInput {
	const raw = process.env.BRAID_DAEMON_INPUT;
	if (!raw) {
		throw new Error("braid daemon started without BRAID_DAEMON_INPUT");
	}
	return JSON.parse(raw) as DaemonInput;
}

/** Sends one handshake message back to the CLI process that forked this daemon, if still connected
 *  (a no-op once the CLI has moved on - see `DaemonHandshakeMessage`'s own doc comment). */
export function send(message: DaemonHandshakeMessage): void {
	process.send?.(message);
}

/** Loads this fork's input, runs the manager to completion, and exits with its resulting code -
 *  the whole lifetime of the daemon process. Rejects (rather than exiting itself) on any failure
 *  before or during `runManager`, so the caller below can report it and choose the exit code. */
export async function main(): Promise<void> {
	const input = loadInput();
	const exitCode = await runManager(input.processes, input.pidfilePath, {
		plugins: input.plugins,
		configPath: input.configPath,
		logs: input.logs,
		statsPollIntervalMs: input.statsPollIntervalMs,
		onReady: () => send({ type: "ready" }),
	});
	process.exit(exitCode);
}

/** Reports a fatal startup failure (a bad `BRAID_DAEMON_INPUT`, or anything `runManager` itself
 *  threw before ever forking a worker) both to `daemon.log` (this process's own stderr, redirected
 *  there by `cli.ts`'s `startDaemon`) and back to the CLI via the handshake protocol, so it can
 *  print a clear message instead of just "the daemon didn't confirm startup in time". */
export function reportStartupFailure(error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`${braidTag()} daemon failed to start: ${message}\n`);
	send({ type: "error", message });
}

// Thin process entrypoint - exercised end-to-end via cli.spec.ts through a real forked process;
// the pieces above are unit-tested directly in daemon.spec.ts instead of re-testing this glue.
/* istanbul ignore next */
if (process.env.BRAID_DAEMON_INPUT) {
	main().catch((error: unknown) => {
		reportStartupFailure(error);
		process.exit(1);
	});
}
