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

export type PidfileWorker = { name: string; pid: number };

export type Pidfile = {
	managerPid: number;
	startedAt: string;
	workers: PidfileWorker[];
};
