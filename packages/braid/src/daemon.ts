import { installFatalHandlers } from "./fatal-handlers.js";
import { runManager, shutdownBudgetMs } from "./manager.js";
import { braidTag } from "./prefix.js";
import type {
	DaemonHandshakeMessage,
	DaemonInput,
	DaemonInputMessage,
} from "./types.js";

// How long a freshly forked daemon waits for its input from the CLI. The CLI sends it right after
// forking, and IPC buffers it until this side listens, so this only trips if the CLI died first.
export const INPUT_TIMEOUT_MS = 5000;

/** The part of `process` receiveInput needs - injectable, since in tests the real IPC channel
 *  belongs to the test runner. */
export type InputChannel = {
	on(event: "message", listener: (message: unknown) => void): unknown;
	off(event: "message", listener: (message: unknown) => void): unknown;
};

function isInputMessage(message: unknown): message is DaemonInputMessage {
	return (
		typeof message === "object" &&
		message !== null &&
		(message as { type?: unknown }).type === "braid-daemon-input"
	);
}

/**
 * Waits for the daemon's input - the CLI's loaded config - to arrive over IPC from the `braid start`
 * that forked it (see `DaemonInputMessage`). Passed rather than re-read from disk because a config
 * file can be arbitrary JS/TS, not just data, so re-importing it from another process isn't a safe
 * substitute. Any other message on the channel is ignored.
 */
export function receiveInput(
	channel: InputChannel = process,
	timeoutMs = INPUT_TIMEOUT_MS,
): Promise<DaemonInput> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			channel.off("message", onMessage);
			reject(
				new Error(
					`braid daemon didn't receive its config from the CLI within ${timeoutMs}ms`,
				),
			);
		}, timeoutMs);
		function onMessage(message: unknown): void {
			if (!isInputMessage(message)) return;
			clearTimeout(timer);
			channel.off("message", onMessage);
			resolve(message.input);
		}
		channel.on("message", onMessage);
	});
}

/** Sends one handshake message back to the CLI process that forked this daemon, if still connected
 *  (a no-op once the CLI has moved on - see `DaemonHandshakeMessage`'s own doc comment). */
export function send(message: DaemonHandshakeMessage): void {
	// Checked first because the CLI disconnects once it has moved on (including after its own
	// startup timeout, while this daemon may still be booting). The callback covers the remaining
	// race - a disconnect landing between the check and the send: with a callback, Node hands
	// ERR_IPC_CHANNEL_CLOSED to it, while without one it's emitted as an uncaught 'error' event
	// that would kill this daemon outright.
	if (!process.connected) return;
	process.send?.(message, () => {});
}

/** Receives this fork's input, runs the manager to completion, and exits with its resulting code -
 *  the whole lifetime of the daemon process. Rejects (rather than exiting itself) on any failure
 *  before or during `runManager`, so the caller below can report it and choose the exit code. */
export async function main(channel: InputChannel = process): Promise<void> {
	const input = await receiveInput(channel);
	const controller = new AbortController();
	installFatalHandlers(controller, shutdownBudgetMs(input.processes) + 5000);
	const exitCode = await runManager(input.processes, input.pidfilePath, {
		plugins: input.plugins,
		configPath: input.configPath,
		logs: input.logs,
		statsPollIntervalMs: input.statsPollIntervalMs,
		onReady: () => send({ type: "ready" }),
		signal: controller.signal,
	});
	process.exit(exitCode);
}

/** Reports a fatal startup failure (no input from the CLI, or anything `runManager` itself
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
if (process.env.BRAID_DAEMON === "1") {
	// Only a marker that this module is the daemon entrypoint - removed straight away so nothing
	// the daemon spawns inherits it (child-env.ts strips it too).
	delete process.env.BRAID_DAEMON;
	main().catch((error: unknown) => {
		reportStartupFailure(error);
		process.exit(1);
	});
}
