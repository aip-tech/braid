import { type ChildProcess, spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { type FSWatcher, watch as watchFiles } from "chokidar";
import treeKill from "tree-kill";
import { childEnv } from "./child-env.js";
import { type LinePrefixer, linePrefixer } from "./prefix.js";
import type {
	ProcessConfig,
	RestartHook,
	WorkerStatusMessage,
} from "./types.js";

// Exported (alongside the other tuning constants below) so worker.spec.ts can drive its fake-timer
// tests off the exact same values, instead of duplicating - and risking silently drifting from -
// magic numbers of its own.
export const DEFAULT_EXT = "ts,js,json";
// Coalesces multiple files saved together into one restart cycle.
export const RESTART_DEBOUNCE_MS = 100;
export const DEFAULT_HOOK_RETRIES = 5;
export const DEFAULT_HOOK_RETRY_DELAY_MS = 1000;
// How long a watch-triggered restart waits after SIGTERM before escalating to SIGKILL.
export const DEFAULT_STOP_TIMEOUT_MS = 5000;
export const DEFAULT_MAX_RESTARTS = 10;
export const DEFAULT_RESTART_DELAY_MS = 1000;
export const DEFAULT_MIN_UPTIME_MS = 1000;
// How long to keep waiting for an exit after SIGKILL before giving up on ever seeing one - a lost
// exit event must not hang a stop (or every later restart) forever.
export const SIGKILL_EXIT_WAIT_MS = 2000;
// Ceiling on a single autoRestart backoff wait - not user-configurable, just a backstop against a
// pathological restartDelayMs producing multi-minute per-attempt waits.
export const DEFAULT_MAX_RESTART_DELAY_MS = 10_000;
// Mirrors nodemon's own default ignore list (its `ignore-by-default` dependency) - deliberately
// not extended with dotfile exclusion, which nodemon does *not* do by default either, so a
// config watching a dotfile (.env, .eslintrc.js) keeps working.
const DEFAULT_IGNORED = [
	"**/.git/**",
	"**/.nyc_output/**",
	"**/.sass-cache/**",
	"**/bower_components/**",
	"**/coverage/**",
	"**/node_modules/**",
];

/** Reads and parses this fork's `BRAID_CONFIG` env var - the one process this worker runs, passed
 *  by `manager.ts`'s `spawnWorker` rather than re-read from disk (see `daemon.ts`'s `loadInput`
 *  for the same reasoning: a config file can be arbitrary JS/TS, not just data). */
export function loadConfig(): ProcessConfig {
	const raw = process.env.BRAID_CONFIG;
	if (!raw) {
		throw new Error("braid worker started without BRAID_CONFIG");
	}
	return JSON.parse(raw) as ProcessConfig;
}

// process.send() only queues the write; calling process.exit() right after can drop the message
// before it flushes to the parent, so exiting is deferred to this callback.
function send(message: WorkerStatusMessage, onSent: () => void): void {
	if (process.send) {
		process.send(message, () => onSent());
	} else {
		onSent();
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Sends `signal` to `pid`'s whole process tree and resolves once it has been sent. */
function killTree(pid: number, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
	return new Promise((resolveKill) =>
		treeKill(pid, signal, () => resolveKill()),
	);
}

/**
 * Races `exited` against `timeoutMs`; SIGKILLs `pid` and awaits `exited` again if it times out,
 * calling `onEscalate` first (for the caller's own "sending SIGKILL" log line), and `onGiveUp` if
 * even that exit never arrives within SIGKILL_EXIT_WAIT_MS. The caller is
 * responsible for having already sent the initial SIGTERM and wired up `exited` (via
 * `awaitingExit`) before calling this - this only owns the "did it comply in time" half.
 */
async function escalateIfNotExited(
	pid: number,
	exited: Promise<void>,
	timeoutMs: number,
	onEscalate: () => void,
	onGiveUp: () => void,
): Promise<void> {
	let timer: NodeJS.Timeout | undefined;
	const timedOut = new Promise<boolean>((resolveTimeout) => {
		timer = setTimeout(() => resolveTimeout(true), timeoutMs);
	});
	const didTimeOut = await Promise.race([exited.then(() => false), timedOut]);
	clearTimeout(timer);
	if (didTimeOut) {
		onEscalate();
		void killTree(pid, "SIGKILL");
		let killTimer: NodeJS.Timeout | undefined;
		const gaveUp = await Promise.race([
			exited.then(() => false),
			new Promise<boolean>((resolveGiveUp) => {
				killTimer = setTimeout(() => resolveGiveUp(true), SIGKILL_EXIT_WAIT_MS);
			}),
		]);
		clearTimeout(killTimer);
		if (gaveUp) onGiveUp();
	}
}

/** Runs `hook` once, piping its output through the same prefixers as the process's own output.
 *  `onSpawn` is handed the hook's process, so a stop can kill one that's mid-run. */
function runHookOnce(
	hook: RestartHook,
	stdoutPrefixer: LinePrefixer,
	stderrPrefixer: LinePrefixer,
	onSpawn: (child: ChildProcess) => void,
): Promise<boolean> {
	return new Promise((resolveHook) => {
		const hookChild = spawn(hook.command, hook.args ?? [], {
			cwd: hook.cwd ? join(process.cwd(), hook.cwd) : process.cwd(),
			env: childEnv(process.env),
		});
		onSpawn(hookChild);
		hookChild.stdout?.on("data", (chunk: Buffer) =>
			stdoutPrefixer.write(chunk),
		);
		hookChild.stderr?.on("data", (chunk: Buffer) =>
			stderrPrefixer.write(chunk),
		);
		hookChild.on("exit", (code) => resolveHook(code === 0));
		hookChild.on("error", () => resolveHook(false));
	});
}

/** Retries `hook`, since whatever it needs (a dependency, a build) may still be catching up -
 *  unless `shouldAbort` says the worker is stopping, in which case it gives up straight away. */
async function runHookWithRetries(
	hook: RestartHook,
	stdoutPrefixer: LinePrefixer,
	stderrPrefixer: LinePrefixer,
	shouldAbort: () => boolean,
	onSpawn: (child: ChildProcess) => void,
): Promise<boolean> {
	const retries = hook.retries ?? DEFAULT_HOOK_RETRIES;
	const retryDelayMs = hook.retryDelayMs ?? DEFAULT_HOOK_RETRY_DELAY_MS;
	for (let attempt = 0; attempt <= retries; attempt++) {
		if (await runHookOnce(hook, stdoutPrefixer, stderrPrefixer, onSpawn)) {
			return true;
		}
		if (shouldAbort()) return false;
		if (attempt < retries) await delay(retryDelayMs);
		if (shouldAbort()) return false;
	}
	return false;
}

export type WorkerHandle = {
	/**
	 * Last-resort cleanup for an error nothing else caught inside this worker: SIGKILLs the app's
	 * whole process group, reports the error, and exits 1. Without it, an uncaught exception here
	 * would exit the worker and leave its app reparented to init, out of everyone's reach. Wired to
	 * `uncaughtException`/`unhandledRejection` by the entrypoint at the bottom of this file, not by
	 * runWorker itself, so an in-process caller (tests) isn't saddled with process-wide handlers.
	 */
	fatal(error: unknown): void;
};

export function runWorker(config: ProcessConfig): WorkerHandle {
	// A separate env var rather than a field on ProcessConfig itself - it's a global logs setting
	// (see RunManagerOptions.logs), not something an individual process's own config carries.
	const timestamps = process.env.BRAID_LOG_TIMESTAMPS === "1";
	// Cleared once the manager is gone (see the "disconnect" handler below): stdout/stderr are
	// pipes to it, so every write after that point could only fail.
	let outputOpen = true;
	const stdoutPrefixer = linePrefixer(
		(line) => {
			if (outputOpen) process.stdout.write(line);
		},
		config.name,
		config.color,
		timestamps,
	);
	const stderrPrefixer = linePrefixer(
		(line) => {
			if (outputOpen) process.stderr.write(line);
		},
		config.name,
		config.color,
		timestamps,
	);
	// stdout/stderr are pipes to the manager. If it dies, the next write fails with EPIPE - which,
	// unhandled, kills this worker before it can stop its app, orphaning it. Never fatal here.
	const ignoreStreamError = (): void => {};
	process.stdout.on("error", ignoreStreamError);
	process.stderr.on("error", ignoreStreamError);
	const watched = Boolean(config.watch && config.watch.length > 0);

	let child: ChildProcess | null = null;
	// Set only while WE are killing `child` on purpose (a watch-triggered restart) - distinguishes
	// that from an unprompted exit/crash in the exit handler below.
	let awaitingExit: (() => void) | undefined;
	// True for the whole stop -> hook -> respawn cycle (a watch-triggered restart) or backoff-wait
	// -> respawn cycle (an autoRestart retry), not just either's own debounce/delay window - a slow
	// beforeRestart retry, or a pending autoRestart backoff wait, shouldn't let an overlapping cycle
	// start from a second file change or a second crash. Hoisted out of the `if (watched)` block
	// below (which still declares `triggerRestart`, the only watch-specific user of this flag)
	// since autoRestart's own crash-branch logic needs it regardless of whether `watch` is set.
	let restarting = false;
	// Resolves whoever's waiting (currently only the SIGTERM handler below) the next time
	// `restarting` clears - an event instead of polling, since nothing else in this file polls.
	let notifyWhenNotRestarting: (() => void) | undefined;
	function whenNotRestarting(): Promise<void> {
		if (!restarting) return Promise.resolve();
		return new Promise((resolve) => {
			notifyWhenNotRestarting = resolve;
		});
	}
	function markRestartingDone(): void {
		restarting = false;
		notifyWhenNotRestarting?.();
		notifyWhenNotRestarting = undefined;
	}
	// True only during an autoRestart backoff wait (set right before it, cleared once the wait
	// elapses and a fresh spawn actually happens) - lets a SIGTERM landing mid-wait cancel the
	// pending retry outright instead of sitting through it (see the SIGTERM handler below).
	let pendingAutoRestartTimer: NodeJS.Timeout | undefined;
	// autoRestart's consecutive-failure tracking - reset once a run stays up for minUptimeMs.
	let consecutiveCrashes = 0;
	let lastSpawnAt = 0;

	function scheduleAutoRestart(exitCode: number | null): void {
		restarting = true;
		const maxRestarts = config.maxRestarts ?? DEFAULT_MAX_RESTARTS;
		const restartDelayMs = config.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS;
		const delayMs = Math.min(
			restartDelayMs * 2 ** (consecutiveCrashes - 1),
			DEFAULT_MAX_RESTART_DELAY_MS,
		);
		stderrPrefixer.write(
			`braid: "${config.name}" crashed (exit code ${exitCode}), restarting in ${delayMs}ms (attempt ${consecutiveCrashes}/${maxRestarts})\n`,
		);
		pendingAutoRestartTimer = setTimeout(async () => {
			pendingAutoRestartTimer = undefined;
			try {
				// Sent right before respawning, not at the top of this wait: a manual stop landing
				// during a multi-second backoff would otherwise kill this fork before "started" ever
				// follows "restart", leaving this name stuck in manager.ts's awaitingFreshStart Set
				// forever (nothing else ever clears it). From here on everything is synchronous, so
				// there's no such gap.
				send({ source: "braid-worker", type: "restart" }, () => {});
				spawnApp();
				send({ source: "braid-worker", type: "started" }, () => {});
			} finally {
				markRestartingDone();
			}
		}, delayMs);
	}

	/** After a SIGKILL whose exit never arrives (see SIGKILL_EXIT_WAIT_MS): stop waiting on it. */
	function giveUpWaiting(): void {
		stderrPrefixer.write(
			`braid: "${config.name}" still hadn't exited ${SIGKILL_EXIT_WAIT_MS}ms after SIGKILL; giving up waiting on it\n`,
		);
		awaitingExit = undefined;
		child = null;
	}

	function spawnApp(): void {
		lastSpawnAt = Date.now();
		const spawned = spawn(config.command, config.args ?? [], {
			env: childEnv(process.env, config.env),
			// Its own process group: a terminal Ctrl-C (sent to the whole foreground group) then
			// reaches only braid's processes, which stop the app in order, rather than racing them to
			// it. It also gives the app a group id (its own pid) that can be killed in one call, with
			// no process-tree walk, when this worker has to give up abruptly (see `fatal`).
			detached: true,
		});
		child = spawned;
		// Node can emit 'error' (a spawn failure: ENOENT, EACCES) and may or may not follow it with
		// 'exit' - settled makes whichever arrives first the only one that counts.
		let settled = false;
		if (typeof spawned.pid === "number") {
			send({ source: "braid-worker", type: "app", pid: spawned.pid }, () => {});
		}
		// Re-attached on every respawn, not just once - otherwise output after the first restart
		// would silently stop reaching the logs.
		spawned.stdout?.on("data", (chunk: Buffer) => stdoutPrefixer.write(chunk));
		spawned.stderr?.on("data", (chunk: Buffer) => stderrPrefixer.write(chunk));
		spawned.on("error", (error) => {
			if (settled) return;
			settled = true;
			stderrPrefixer.write(
				`braid: failed to start "${config.command}": ${error.message}\n`,
			);
			// Not retried via autoRestart: a missing or non-executable command fails identically
			// every time, so backing off and retrying would only delay the report.
			onAppExit(null, { retry: false });
		});
		spawned.on("exit", (code) => {
			if (settled) return;
			settled = true;
			onAppExit(code, { retry: true });
		});
	}

	function onAppExit(code: number | null, { retry }: { retry: boolean }): void {
		stdoutPrefixer.flush();
		stderrPrefixer.flush();
		if (awaitingExit) {
			const done = awaitingExit;
			awaitingExit = undefined;
			child = null;
			done();
			return;
		}
		if (code === 0) {
			// Clean, unplanned exit - not a crash. For a non-watched config this exits the worker
			// exactly as before; for a watched one, go idle until the next matching file change.
			if (!watched) process.exit(0);
			child = null;
			return;
		}
		const minUptimeMs = config.minUptimeMs ?? DEFAULT_MIN_UPTIME_MS;
		if (Date.now() - lastSpawnAt >= minUptimeMs) consecutiveCrashes = 0;
		consecutiveCrashes++;
		if (
			retry &&
			config.autoRestart &&
			consecutiveCrashes <= (config.maxRestarts ?? DEFAULT_MAX_RESTARTS)
		) {
			child = null;
			scheduleAutoRestart(code);
			return;
		}
		if (retry && config.autoRestart) {
			stderrPrefixer.write(
				`braid: "${config.name}" crashed ${consecutiveCrashes} times within its uptime window, giving up\n`,
			);
		}
		if (!watched) {
			send({ source: "braid-worker", type: "crash", code }, () =>
				process.exit(code ?? 1),
			);
		} else {
			send({ source: "braid-worker", type: "crash", code }, () => {});
			child = null;
		}
	}

	spawnApp();

	// A worker fork installs no signal handling by default, so it dies immediately on SIGTERM
	// (manager.ts's stopChild sends it there for every manager-initiated stop: a manual `braid
	// stop`, a dependsOn cascade's respawn, or daemon shutdown) regardless of whether its own
	// inner `child` app actually complied - leaving a `child` that ignores SIGTERM running forever,
	// orphaned once this fork exits out from under it. stopAndExit makes the fork's own exit
	// (which manager.ts's stopChild waits on) actually mean "the inner app is confirmed dead too".
	let stopping = false;
	// Hoisted out of the `if (watched)` block below so a stop can cancel them: a watch-triggered
	// restart that's still only debouncing must never start once a stop has begun, and a
	// beforeRestart hook that's mid-run must not keep retrying under it.
	let debounceTimer: NodeJS.Timeout | undefined;
	let watcher: FSWatcher | undefined;
	let runningHook: ChildProcess | undefined;
	async function stopAndExit(): Promise<void> {
		if (stopping) return; // a second signal while already stopping - ignore, in progress
		stopping = true;
		clearTimeout(debounceTimer);
		void watcher?.close();
		if (typeof runningHook?.pid === "number")
			void killTree(runningHook.pid, "SIGTERM");

		if (pendingAutoRestartTimer) {
			// Mid an autoRestart backoff wait - `restarting` is already true for this whole
			// window (see scheduleAutoRestart), but nothing is actually running right now, so
			// there's nothing to wait out or kill: cancel the pending retry immediately rather
			// than sitting through the rest of it only to spawn a fresh instance and
			// immediately kill that instead. Handled before `whenNotRestarting()` below - that
			// call is only for an in-flight *watch-triggered* restart's own kill sequence,
			// which genuinely is mid-flight and must be waited out, not cancelled out from
			// under it.
			clearTimeout(pendingAutoRestartTimer);
			pendingAutoRestartTimer = undefined;
			markRestartingDone();
		} else {
			// A watch-triggered restart already in flight owns `child`/`awaitingExit` right
			// now - wait for it to finish rather than racing it for either.
			await whenNotRestarting();
			restarting = true; // claim it for our own kill below, so nothing else (a file
			try {
				// change, a fresh crash) can start a competing cycle meanwhile
				if (child?.pid) {
					const pid = child.pid;
					const exited = new Promise<void>((resolveExit) => {
						awaitingExit = resolveExit;
					});
					void killTree(pid, "SIGTERM");
					const timeoutMs = config.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
					await escalateIfNotExited(
						pid,
						exited,
						timeoutMs,
						() =>
							stderrPrefixer.write(
								`braid: "${config.name}" did not exit within ${timeoutMs}ms of SIGTERM; sending SIGKILL\n`,
							),
						giveUpWaiting,
					);
				}
			} finally {
				markRestartingDone();
			}
		}
		process.exit(0);
	}
	process.on("SIGTERM", () => void stopAndExit());
	// In the foreground, a terminal Ctrl-C reaches this worker too (the manager stops it by SIGTERM
	// regardless) - without a handler, the default disposition kills it on the spot, skipping the
	// stop-the-app sequence above and orphaning an app that ignores SIGINT.
	process.on("SIGINT", () => void stopAndExit());
	if (process.send) {
		// The IPC channel only closes under us if the manager itself is gone (a normal stop always
		// SIGTERMs this worker, and waits on its exit, first) - stop the app rather than leave it
		// running unsupervised, and stop writing to the now-dead manager's pipes.
		process.on("disconnect", () => {
			outputOpen = false;
			void stopAndExit();
		});
	}

	if (watched) {
		// process.cwd() is already config.cwd-resolved (manager forks this worker with that cwd) -
		// resolve(), not join(), so an already-absolute watch entry isn't mangled.
		const paths = (config.watch as string[]).map((path) =>
			resolve(process.cwd(), path),
		);
		const allowedExts = (config.ext ?? DEFAULT_EXT)
			.split(",")
			.map((ext) => ext.trim().toLowerCase());
		// Each entry excludes itself (matters if it's a file, or for the directory node chokidar
		// tests before deciding whether to recurse) and its whole subtree via the /** suffix - a
		// plain glob entry (already containing wildcards) just gets a second, harmlessly-unmatched
		// pattern alongside its own.
		const excluded = (config.exclude ?? []).flatMap((path) => {
			const resolved = resolve(process.cwd(), path);
			return [resolved, `${resolved}/**`];
		});
		const fileWatcher = watchFiles(paths, {
			ignored: [...DEFAULT_IGNORED, ...excluded],
			ignoreInitial: true,
			// chokidar's own default (2000ms) is too slow for a prompt, reliable restart.
			awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 50 },
		});

		// `restarting` is declared at the top of runWorker (shared with autoRestart's crash-branch
		// logic), and `debounceTimer` next to `stopping` - neither is re-declared here.

		async function triggerRestart(): Promise<void> {
			// A stop that began while this was still debouncing owns `child` now (normally the timer
			// is cleared by then, but its callback may already have been queued).
			if (stopping) return;
			restarting = true;
			try {
				// Sent before the kill, same observable timing as before - manager's handling of this
				// message has no ordering dependency on the child actually being dead yet.
				send({ source: "braid-worker", type: "restart" }, () => {});
				const pid = child?.pid;
				if (typeof pid === "number") {
					stderrPrefixer.write("braid: stopping (restarting)\n");
					const exited = new Promise<void>((resolveExit) => {
						awaitingExit = resolveExit;
					});
					void killTree(pid, "SIGTERM");
					// Without this, an app that traps/ignores SIGTERM would hang this restart forever -
					// `restarting` never clears, so every later file change is silently swallowed too.
					const timeoutMs = config.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
					await escalateIfNotExited(
						pid,
						exited,
						timeoutMs,
						() =>
							stderrPrefixer.write(
								`braid: "${config.name}" did not exit within ${timeoutMs}ms of SIGTERM; sending SIGKILL\n`,
							),
						giveUpWaiting,
					);
				}
				// A stop that landed while the old app was being killed takes it from here.
				if (stopping) return;
				if (config.beforeRestart) {
					const ok = await runHookWithRetries(
						config.beforeRestart,
						stdoutPrefixer,
						stderrPrefixer,
						() => stopping,
						(hookChild) => {
							runningHook = hookChild;
						},
					);
					runningHook = undefined;
					if (stopping) return;
					if (!ok) {
						stderrPrefixer.write(
							`braid: beforeRestart hook "${config.beforeRestart.command}" kept failing; leaving it stopped\n`,
						);
						return;
					}
				}
				spawnApp();
				send({ source: "braid-worker", type: "started" }, () => {});
			} finally {
				markRestartingDone();
			}
		}

		watcher = fileWatcher;
		fileWatcher.on("all", (_event, changedPath) => {
			if (restarting) return;
			const ext = changedPath.split(".").pop()?.toLowerCase();
			if (!ext || !allowedExts.includes(ext)) return;
			clearTimeout(debounceTimer);
			debounceTimer = setTimeout(
				() => void triggerRestart(),
				RESTART_DEBOUNCE_MS,
			);
		});
	}

	return {
		fatal(error) {
			const pid = child?.pid;
			if (typeof pid === "number") {
				try {
					// Negative pid: the app's whole process group (it was spawned detached), in one
					// synchronous call - no async process-tree walk that this dying worker might not
					// live to finish.
					process.kill(-pid, "SIGKILL");
				} catch {
					// already gone
				}
			}
			const message =
				error instanceof Error ? (error.stack ?? error.message) : String(error);
			stderrPrefixer.write(`braid: worker internal error: ${message}\n`);
			stderrPrefixer.flush();
			process.exit(1);
		},
	};
}

// Exercised via manager.spec.ts through a real forked process, not unit-tested directly.
/* istanbul ignore next */
if (process.env.BRAID_CONFIG) {
	const worker = runWorker(loadConfig());
	process.on("uncaughtException", worker.fatal);
	process.on("unhandledRejection", worker.fatal);
}
