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
	/**
	 * Directories to watch for changes. When set, the process runs under nodemon and restarts on
	 * matching file changes. When omitted, the command runs once and is expected to manage its own
	 * reload (e.g. a command that already wraps itself in `tsx watch`, or a dev server with its own HMR).
	 */
	watch?: string[];
	/** File extensions nodemon watches, comma-separated (nodemon's own format). Only used when `watch` is set. */
	ext?: string;
};

export type WorkerStatusMessage = { type: "crash"; code: number | null };

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

/**
 * A config's `plugins` entry: either a bare package name / local path, or a
 * tuple pairing one with an options object passed through to that plugin's
 * `register()`.
 */
export type PluginConfigEntry = string | [string, Record<string, unknown>];

/**
 * The object form a braid config file can default-export. A bare
 * `ProcessConfig[]` (today's format) normalizes to `{ processes }` with no
 * plugins - see loadConfig in cli.ts.
 */
export type BraidConfig = {
	processes: ProcessConfig[];
	plugins?: PluginConfigEntry[];
};

/**
 * Lifecycle events plugins can subscribe to via PluginContext.on(). Dispatched
 * through safeEmit (plugin-runtime.ts), never a raw EventEmitter.emit(), so a
 * throwing or rejecting listener can't take the manager down.
 */
export type PluginLifecycleEvent =
	| { type: "processStart"; name: string; pid: number }
	| {
			type: "processExit";
			name: string;
			code: number | null;
			signal: NodeJS.Signals | null;
	  }
	| { type: "processCrash"; name: string; code: number | null }
	| { type: "daemonShutdown" };

export type RouteHandler = (
	req: IncomingMessage,
	res: ServerResponse,
) => void | Promise<void>;

export type UpgradeHandler = (
	req: IncomingMessage,
	socket: Duplex,
	head: Buffer,
) => void;

/**
 * The capability surface handed to a plugin's register(). One instance per
 * plugin (see createPluginContextFactory in plugin-runtime.ts), so log()
 * calls can be attributed to the plugin that made them.
 */
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

/**
 * The contract every plugin implements, whether it's a core plugin (statically
 * imported, compiled into @aip-tech/braid itself) or an external one (declared
 * by package name/path in a config's `plugins` array and dynamically loaded).
 */
export type BraidPlugin = {
	name: string;
	register(
		ctx: PluginContext,
		options?: Record<string, unknown>,
	): void | Promise<void>;
};
