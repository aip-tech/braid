import { spawn } from "node:child_process";
import nodemon from "nodemon";
import { linePrefixer } from "./prefix.js";
import type { ProcessConfig, WorkerStatusMessage } from "./types.js";

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

export function runWorker(config: ProcessConfig): void {
	const stdoutPrefixer = linePrefixer(
		(line) => process.stdout.write(line),
		config.name,
		config.color,
	);
	const stderrPrefixer = linePrefixer(
		(line) => process.stderr.write(line),
		config.name,
		config.color,
	);

	if (config.watch && config.watch.length > 0) {
		// nodemon's programmatic API silently no-ops (no start/restart/crash event, ever) when
		// `exec` is exactly "node" with no separate `script` - it assumes that shape means the
		// caller forgot to pass a script. Route through `script` instead in that one case so
		// `command: "node", args: [script, ...]` (a very natural config) actually restarts.
		const runsPlainNode =
			config.command === "node" && (config.args?.length ?? 0) > 0;
		const monitor = nodemon({
			...(runsPlainNode
				? { script: config.args?.[0], args: config.args?.slice(1) }
				: { exec: config.command, args: config.args }),
			watch: config.watch,
			ext: config.ext ?? "ts,js,json",
			env: config.env,
			stdout: false,
		});

		monitor.on(
			"readable",
			function readable(this: {
				stdout: NodeJS.ReadableStream;
				stderr: NodeJS.ReadableStream;
			}) {
				this.stdout.on("data", (chunk: Buffer) => stdoutPrefixer.write(chunk));
				this.stderr.on("data", (chunk: Buffer) => stderrPrefixer.write(chunk));
			},
		);
		monitor.on("crash", () =>
			send({ source: "braid-worker", type: "crash", code: null }, () => {}),
		);
		monitor.on("restart", () =>
			send({ source: "braid-worker", type: "restart" }, () => {}),
		);
		// Fires at initial start too, not just restarts - the manager only acts on it when it's
		// actually expecting one (i.e. right after a "restart" message), see manager.ts.
		monitor.on("start", () =>
			send({ source: "braid-worker", type: "started" }, () => {}),
		);
		monitor.on("quit", () => {
			stdoutPrefixer.flush();
			stderrPrefixer.flush();
			process.exit(0);
		});
		return;
	}

	const child = spawn(config.command, config.args ?? [], {
		env: { ...process.env, ...config.env },
	});

	child.stdout.on("data", (chunk: Buffer) => stdoutPrefixer.write(chunk));
	child.stderr.on("data", (chunk: Buffer) => stderrPrefixer.write(chunk));
	child.on("exit", (code, signal) => {
		stdoutPrefixer.flush();
		stderrPrefixer.flush();
		const exit = () => process.exit(code ?? 0);
		if (code !== 0 && signal === null) {
			send({ source: "braid-worker", type: "crash", code }, exit);
		} else {
			exit();
		}
	});
}

// Exercised via manager.spec.ts through a real forked process, not unit-tested directly.
/* istanbul ignore next */
if (process.env.BRAID_CONFIG) {
	runWorker(loadConfig());
}
