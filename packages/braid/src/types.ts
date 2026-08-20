import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

/** A command run as part of a restart, retried on non-zero exit since a dependency it needs (an API server, a workspace package's build) may still be catching up. */
export type RestartHook = {
	command: string;
	args?: string[];
	cwd?: string;
	/** @default 5 */
	retries?: number;
	/** Delay between retries, in ms. @default 1000 */
	retryDelayMs?: number;
};

export type ProcessConfig = {
	/** Unique name used for log prefixes, the pidfile, and status output. */
	name: string;
	/** Command to run, e.g. "pnpm". */
	command: string;
	args?: string[];
	/** Working directory, resolved relative to wherever the CLI was invoked. Defaults to that same directory. */
	cwd?: string;
	/** Extra environment variables merged over process.env for this process only. */
	env?: Record<string, string>;
	/** ANSI color name used for this process's log prefix (see COLOR_CODES in prefix.ts). */
	color?: string;
	/** Paths to watch for changes; when set, braid restarts the process on a matching change. */
	watch?: string[];
	/**
	 * File extensions to watch, comma-separated. Only used when `watch` is set.
	 * @default "ts,js,json"
	 */
	ext?: string;
	/**
	 * A regex (as a string, passed to `new RegExp()`) matched against this process's own
	 * stdout/stderr after each restart. Until it matches (or `readyTimeoutMs` elapses), `onRestart`
	 * and any dependents' `dependsOn` cascades are held off - e.g. an API's own
	 * `"Server listening"` log line, so a client's codegen hook doesn't run against a server that's
	 * merely been re-spawned but hasn't finished its own startup yet. Without this, both are held
	 * off only until the new process has been (re)spawned (a fresh spawn is otherwise
	 * indistinguishable from "ready"), and a `run`/`onRestart` hook's own retry is the only thing
	 * bridging the remaining gap.
	 */
	readyPattern?: string;
	/** How long to wait for `readyPattern` before giving up and proceeding anyway. @default 10000 */
	readyTimeoutMs?: number;
	/**
	 * Restart this process whenever any of these other configured processes restarts (a
	 * `watch`-triggered restart, or one cascaded from its own `dependsOn`). Referencing an
	 * unknown process name, or a chain that loops back on itself, is rejected at startup.
	 */
	dependsOn?: {
		/** Names of other processes in this same config; any of their restarts triggers this one. */
		processes: string[];
		/** Command run after a dependency restarts and before this process restarts. */
		run?: RestartHook;
	};
	/**
	 * Run a command after this process itself restarts (a `watch`-triggered restart) - e.g.
	 * rebuilding a shared workspace package other processes read from without themselves needing
	 * to restart. Dependents (via `dependsOn`) aren't notified of this restart until the hook
	 * succeeds, and not at all if it never does.
	 */
	onRestart?: RestartHook;
	/**
	 * Run a command once this process's own watched files change, after the old process is
	 * confirmed dead and before a fresh one starts - e.g. regenerating something the new process
	 * needs on disk before it boots. Requires `watch`. Retried like `onRestart`/`dependsOn.run`;
	 * if it keeps failing, the process is left stopped and the watcher stays active, so the next
	 * matching file change retries the whole cycle rather than requiring a manual restart.
	 */
	beforeRestart?: RestartHook;
};

/** `source` tags braid's own worker->manager IPC protocol, distinct from any other message shape. */
export type WorkerStatusMessage =
	| { source: "braid-worker"; type: "crash"; code: number | null }
	| { source: "braid-worker"; type: "restart" }
	| {
			/** The process has respawned after a watch-triggered restart - never fires at initial start. */
			source: "braid-worker";
			type: "started";
	  };

export type PidfileWorker = { name: string; pid: number; startedAt: string };

export type Pidfile = {
	managerPid: number;
	startedAt: string;
	workers: PidfileWorker[];
	/** Loopback port of the always-on local control server (see control-server.ts). */
	controlPort: number;
	/** Per-run bearer token the control server requires on every request. */
	controlToken: string;
};

/** A `plugins` entry: a package name/path, or a [name, options] tuple. */
export type PluginConfigEntry = string | [string, Record<string, unknown>];

/** The object form a config file can default-export. A bare `ProcessConfig[]` also works. */
export type BraidConfig = {
	processes: ProcessConfig[];
	plugins?: PluginConfigEntry[];
	/** Per-process log file settings. */
	logs?: {
		/** @default ".braid/logs" (a "logs" directory next to the pidfile) */
		dir?: string;
		/** Size-based rotation backstop, in bytes. @default 5242880 (5MB) */
		maxSizeBytes?: number;
	};
	/**
	 * Run `start` attached to the terminal instead of forking a background daemon. Overridable per
	 * invocation with `--foreground`/`--daemon`. @default false
	 */
	foreground?: boolean;
};

/** Lifecycle events plugins can subscribe to via PluginContext.on(). */
export type PluginLifecycleEvent =
	| { type: "processStart"; name: string; pid: number }
	| {
			type: "processExit";
			name: string;
			code: number | null;
			signal: NodeJS.Signals | null;
	  }
	| { type: "processCrash"; name: string; code: number | null }
	| {
			/** A watched process restarted internally (its app child, not the worker itself), not exited. */
			type: "processRestart";
			name: string;
	  }
	| {
			/** Raw stdout/stderr bytes from a child, already line-prefixed. */
			type: "processOutput";
			name: string;
			stream: "stdout" | "stderr";
			chunk: Buffer;
	  }
	| { type: "daemonShutdown" }
	| {
			/**
			 * Fires once, after the control server is listening and every core/external plugin has
			 * finished register()'ing - the earliest point a plugin can know its own reachable
			 * port/token, e.g. to log a browser-openable URL for content it served via
			 * `registerStatic`.
			 */
			type: "controlServerReady";
			port: number;
			token: string;
	  };

/** Result of `PluginContext.stopProcess`/`restartProcess`: "unknown" means the name isn't
 * configured, or (for `stopProcess`) isn't currently running; "busy" means a restart is already
 * in progress for that name. */
export type ProcessActionResult = "ok" | "unknown" | "busy";

/** Sent from the daemon entrypoint back to the CLI over IPC once startup succeeds or fails. */
export type DaemonHandshakeMessage =
	| { type: "ready" }
	| { type: "error"; message: string };

export type RouteHandler = (
	req: IncomingMessage,
	res: ServerResponse,
) => void | Promise<void>;

export type UpgradeHandler = (
	req: IncomingMessage,
	socket: Duplex,
	head: Buffer,
) => void;

/** The capability surface handed to a plugin's register(). One instance per plugin. */
export type PluginContext = {
	/** Registers an HTTP route on the shared control server. Throws if method+path is already taken. */
	registerRoute(method: string, path: string, handler: RouteHandler): void;
	/** Serves files under `dir` for any request path starting with `prefix`. Throws if `prefix` is already taken. */
	registerStatic(prefix: string, dir: string): void;
	/** Handles a raw HTTP Upgrade request (e.g. a future WebSocket) whose path matches exactly. */
	registerUpgrade(path: string, handler: UpgradeHandler): void;
	on<T extends PluginLifecycleEvent["type"]>(
		type: T,
		handler: (
			event: Extract<PluginLifecycleEvent, { type: T }>,
		) => void | Promise<void>,
	): void;
	getProcesses(): Array<{
		name: string;
		pid: number | undefined;
		alive: boolean;
		startedAt: string;
	}>;
	/**
	 * Stops one named process. Available to any plugin, not just core - a plugin can stop/restart
	 * any configured process, not only ones it registered itself, the same trust level as any other
	 * capability in `node_modules` gets, but worth knowing before wiring it up to something you
	 * didn't write. Resolves "unknown" if `name` isn't configured or isn't currently running, "busy"
	 * if a restart is already in progress for it, "ok" once fully stopped.
	 */
	stopProcess(name: string): Promise<ProcessActionResult>;
	/**
	 * Stops and respawns one named process, then runs its `onRestart` hook (if any) and cascades to
	 * `dependsOn` dependents exactly as a watch-triggered restart would. Can take a while to resolve
	 * if `onRestart` keeps retrying (bounded by its own `retries`/`retryDelayMs`). Resolves "unknown"
	 * if `name` isn't configured, "busy" if already restarting, "ok" once fully restarted.
	 */
	restartProcess(name: string): Promise<ProcessActionResult>;
	/** Writes a line to stderr, prefixed with this plugin's name. */
	log(message: string): void;
};

/** The contract every plugin implements, core or external. */
export type BraidPlugin = {
	name: string;
	register(
		ctx: PluginContext,
		options?: Record<string, unknown>,
	): void | Promise<void>;
};
