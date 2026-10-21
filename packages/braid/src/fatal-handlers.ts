import { braidTag } from "./prefix.js";

/**
 * Process-wide last resort for an error nothing else caught - registered by the two process owners
 * (the daemon entrypoint, and a foreground `start`), never by `runManager` itself: a library caller
 * or test runner hosting runManager in-process shouldn't have every unrelated rejection in that
 * process tear its manager down, and an `uncaughtException` listener changes Node's exit behaviour
 * for the whole process.
 *
 * Without this, Node exits on the spot - leaving every supervised process running, orphaned.
 * Instead: log it, abort `controller` (runManager's `signal` option turns that into an orderly
 * `shutdown(1)`), and arm an unref'd watchdog that exits anyway after `watchdogMs`, so a shutdown
 * that's itself broken by whatever went wrong can't hang the process forever. The watchdog is
 * unref'd, so it never keeps a process alive that would otherwise exit on its own.
 *
 * Returns a function that removes the handlers (the watchdog, once armed, stays).
 */
export function installFatalHandlers(
	controller: AbortController,
	watchdogMs: number,
	exit: (code: number) => void = (code) => process.exit(code),
): () => void {
	const onFatal = (error: unknown): void => {
		const message =
			error instanceof Error ? (error.stack ?? error.message) : String(error);
		process.stderr.write(
			`${braidTag()} internal error, stopping all processes: ${message}\n`,
		);
		// A second fatal error while already stopping is only logged - the watchdog is armed.
		if (controller.signal.aborted) return;
		controller.abort();
		setTimeout(() => exit(1), watchdogMs).unref();
	};
	process.on("uncaughtException", onFatal);
	process.on("unhandledRejection", onFatal);
	return () => {
		process.off("uncaughtException", onFatal);
		process.off("unhandledRejection", onFatal);
	};
}
