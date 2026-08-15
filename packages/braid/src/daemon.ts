import { runManager } from "./manager.js";
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
};

function loadInput(): DaemonInput {
	const raw = process.env.BRAID_DAEMON_INPUT;
	if (!raw) {
		throw new Error("braid daemon started without BRAID_DAEMON_INPUT");
	}
	return JSON.parse(raw) as DaemonInput;
}

function send(message: DaemonHandshakeMessage): void {
	process.send?.(message);
}

async function main(): Promise<void> {
	const input = loadInput();
	const exitCode = await runManager(input.processes, input.pidfilePath, {
		plugins: input.plugins,
		configPath: input.configPath,
		logs: input.logs,
		onReady: () => send({ type: "ready" }),
	});
	process.exit(exitCode);
}

// Exercised via cli.spec.ts through a real forked process, not unit-tested directly.
/* istanbul ignore next */
if (process.env.BRAID_DAEMON_INPUT) {
	main().catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		// Also write to our own stderr (daemon.log, once forked with a redirected fd) - the IPC
		// message is the primary channel, but this is the fallback if that message is ever lost.
		process.stderr.write(`[braid] daemon failed to start: ${message}\n`);
		send({ type: "error", message });
		process.exit(1);
	});
}
