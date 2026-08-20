import { type ChildProcess, spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { watch as watchFiles } from "chokidar";
import treeKill from "tree-kill";
import { type LinePrefixer, linePrefixer } from "./prefix.js";
import type {
	ProcessConfig,
	RestartHook,
	WorkerStatusMessage,
} from "./types.js";

const DEFAULT_EXT = "ts,js,json";
// Coalesces multiple files saved together into one restart cycle.
const RESTART_DEBOUNCE_MS = 100;
const DEFAULT_HOOK_RETRIES = 5;
const DEFAULT_HOOK_RETRY_DELAY_MS = 1000;
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

function loadConfig(): ProcessConfig {
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

/** Sends SIGTERM to `pid`'s whole process tree and resolves once the kill signal has been sent. */
function killTree(pid: number): Promise<void> {
	return new Promise((resolveKill) =>
		treeKill(pid, "SIGTERM", () => resolveKill()),
	);
}

/** Runs `hook` once, piping its output through the same prefixers as the process's own output. */
function runHookOnce(
	hook: RestartHook,
	stdoutPrefixer: LinePrefixer,
	stderrPrefixer: LinePrefixer,
): Promise<boolean> {
	return new Promise((resolveHook) => {
		const hookChild = spawn(hook.command, hook.args ?? [], {
			cwd: hook.cwd ? join(process.cwd(), hook.cwd) : process.cwd(),
			env: process.env,
		});
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

/** Retries `hook`, since whatever it needs (a dependency, a build) may still be catching up. */
async function runHookWithRetries(
	hook: RestartHook,
	stdoutPrefixer: LinePrefixer,
	stderrPrefixer: LinePrefixer,
): Promise<boolean> {
	const retries = hook.retries ?? DEFAULT_HOOK_RETRIES;
	const retryDelayMs = hook.retryDelayMs ?? DEFAULT_HOOK_RETRY_DELAY_MS;
	for (let attempt = 0; attempt <= retries; attempt++) {
		if (await runHookOnce(hook, stdoutPrefixer, stderrPrefixer)) return true;
		if (attempt < retries) await delay(retryDelayMs);
	}
	return false;
}

export function runWorker(config: ProcessConfig): void {
	// A separate env var rather than a field on ProcessConfig itself - it's a global logs setting
	// (see RunManagerOptions.logs), not something an individual process's own config carries.
	const timestamps = process.env.BRAID_LOG_TIMESTAMPS === "1";
	const stdoutPrefixer = linePrefixer(
		(line) => process.stdout.write(line),
		config.name,
		config.color,
		timestamps,
	);
	const stderrPrefixer = linePrefixer(
		(line) => process.stderr.write(line),
		config.name,
		config.color,
		timestamps,
	);
	const watched = Boolean(config.watch && config.watch.length > 0);

	let child: ChildProcess | null = null;
	// Set only while WE are killing `child` on purpose (a watch-triggered restart) - distinguishes
	// that from an unprompted exit/crash in the exit handler below.
	let awaitingExit: (() => void) | undefined;

	function spawnApp(): void {
		child = spawn(config.command, config.args ?? [], {
			env: { ...process.env, ...config.env },
		});
		// Re-attached on every respawn, not just once - otherwise output after the first restart
		// would silently stop reaching the logs.
		child.stdout?.on("data", (chunk: Buffer) => stdoutPrefixer.write(chunk));
		child.stderr?.on("data", (chunk: Buffer) => stderrPrefixer.write(chunk));
		child.on("exit", (code) => {
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
			if (!watched) {
				send({ source: "braid-worker", type: "crash", code }, () =>
					process.exit(code ?? 1),
				);
			} else {
				send({ source: "braid-worker", type: "crash", code }, () => {});
				child = null;
			}
		});
	}

	spawnApp();

	if (watched) {
		// process.cwd() is already config.cwd-resolved (manager forks this worker with that cwd) -
		// resolve(), not join(), so an already-absolute watch entry isn't mangled.
		const paths = (config.watch as string[]).map((path) =>
			resolve(process.cwd(), path),
		);
		const allowedExts = (config.ext ?? DEFAULT_EXT)
			.split(",")
			.map((ext) => ext.trim().toLowerCase());
		const watcher = watchFiles(paths, {
			ignored: DEFAULT_IGNORED,
			ignoreInitial: true,
			// chokidar's own default (2000ms) is too slow for a prompt, reliable restart.
			awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 50 },
		});

		// True for the whole stop -> hook -> respawn cycle, not just the debounce window - a slow
		// beforeRestart retry shouldn't let an overlapping cycle start from a second file change.
		let restarting = false;
		let debounceTimer: NodeJS.Timeout | undefined;

		async function triggerRestart(): Promise<void> {
			restarting = true;
			try {
				// Sent before the kill, same observable timing as before - manager's handling of this
				// message has no ordering dependency on the child actually being dead yet.
				send({ source: "braid-worker", type: "restart" }, () => {});
				const pid = child?.pid;
				if (typeof pid === "number") {
					stderrPrefixer.write("braid: stopping (restarting)\n");
					await new Promise<void>((resolveExit) => {
						awaitingExit = resolveExit;
						void killTree(pid);
					});
				}
				if (config.beforeRestart) {
					const ok = await runHookWithRetries(
						config.beforeRestart,
						stdoutPrefixer,
						stderrPrefixer,
					);
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
				restarting = false;
			}
		}

		watcher.on("all", (_event, changedPath) => {
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
}

// Exercised via manager.spec.ts through a real forked process, not unit-tested directly.
/* istanbul ignore next */
if (process.env.BRAID_CONFIG) {
	runWorker(loadConfig());
}
