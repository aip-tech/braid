import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

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
	/** Paths to watch for changes; when set, the process runs under nodemon and restarts on change. */
	watch?: string[];
	/**
	 * File extensions nodemon watches, comma-separated. Only used when `watch` is set.
	 * @default "ts,js,json"
	 */
	ext?: string;
	/**
	 * Restart this process whenever any of these other configured processes restarts (a
	 * nodemon-triggered `watch` restart, or one cascaded from its own `dependsOn`). Referencing
	 * an unknown process name, or a chain that loops back on itself, is rejected at startup.
	 */
	dependsOn?: {
		/** Names of other processes in this same config; any of their restarts triggers this one. */
		processes: string[];
		/**
		 * Command run after a dependency restarts and before this process restarts - e.g. a
		 * codegen script that needs the dependency (an API server) back up and serving first.
		 * Retried on non-zero exit since the dependency may still be starting back up.
		 */
		run?: {
			command: string;
			args?: string[];
			cwd?: string;
			/** @default 5 */
			retries?: number;
			/** Delay between retries, in ms. @default 1000 */
			retryDelayMs?: number;
		};
	};
};

/**
 * `source` distinguishes braid's own worker->manager IPC protocol from nodemon's own: nodemon
 * monkey-patches its internal event bus to auto-forward every internal event (`restart`, `crash`,
 * `start`, `log`, ...) over the same `process.send` channel whenever it detects it's running
 * under `fork()` - some of those collide in shape with this protocol (e.g. nodemon's own
 * `{ type: "restart", data: [...] }`), so a message missing this marker must be ignored.
 */
export type WorkerStatusMessage =
	| { source: "braid-worker"; type: "crash"; code: number | null }
	| { source: "braid-worker"; type: "restart" };

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
			/** A nodemon-wrapped process restarted internally, not exited. */
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
	| { type: "daemonShutdown" };

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
