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
		statsPollIntervalMs: input.statsPollIntervalMs,
		onReady: () => send({ type: "ready" }),
	});
	process.exit(exitCode);
}

// Exercised via cli.spec.ts through a real forked process, not unit-tested directly.
/* istanbul ignore next */
if (process.env.BRAID_DAEMON_INPUT) {
	main().catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`${braidTag()} daemon failed to start: ${message}\n`);
		send({ type: "error", message });
		process.exit(1);
	});
}
