import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import SonicBoom from "sonic-boom";
import type { BraidPlugin } from "../types.js";

type LoggerOptions = { dir?: string; maxSizeBytes?: number };

const DEFAULT_MAX_SIZE_BYTES = 5 * 1024 * 1024;
// sonic-boom's own in-memory backpressure ceiling: past this it drops writes (emitting 'drop')
// instead of buffering unboundedly. Independent of, and much larger than, the file-size rotation
// threshold above - this is a safety net against an OOM, not a rotation trigger.
const MAX_BUFFERED_BYTES = 10 * 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 20_000;
// Follower bucket key for the "all processes, interleaved" route (no ?name= given).
const ALL_PROCESSES_KEY = "*";

type Destination = {
	stream: SonicBoom;
	filePath: string;
	bytesWritten: number;
};

function rotateFileIfExists(filePath: string): void {
	if (existsSync(filePath)) {
		renameSync(filePath, `${filePath}.1`);
	}
}

function parseLines(query: URLSearchParams): number | undefined {
	const raw = query.get("lines");
	if (!raw) return undefined;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

function tailLines(content: string, lines: number): string {
	const allLines = content.split("\n");
	if (allLines.at(-1) === "") allLines.pop();
	return allLines.length ? `${allLines.slice(-lines).join("\n")}\n` : "";
}

/**
 * Core plugin owning per-process rotated log files and serving them back out over HTTP - both the
 * `braid logs` CLI command and (later) the web UI plugin read through the same /api/logs route,
 * rather than each having their own file-tailing implementation.
 */
export const loggerPlugin: BraidPlugin = {
	name: "core:logger",
	register(ctx, rawOptions) {
		const options = (rawOptions ?? {}) as LoggerOptions;
		const dir = options.dir ?? join(process.cwd(), ".braid", "logs");
		const maxSizeBytes = options.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
		mkdirSync(dir, { recursive: true });

		const destinations = new Map<string, Destination>();
		const followers = new Map<string, Set<ServerResponse>>();

		function getFollowerSet(key: string): Set<ServerResponse> {
			let set = followers.get(key);
			if (!set) {
				set = new Set();
				followers.set(key, set);
			}
			return set;
		}

		function registerFollower(key: string, res: ServerResponse): void {
			const set = getFollowerSet(key);
			set.add(res);
			res.on("close", () => set.delete(res));
			res.on("error", () => set.delete(res));
		}

		// Lazy: workers haven't forked yet when core plugins register (Phase 0's "register
		// everything, then listen(), then fork" sequencing), so a destination is created the first
		// time a name's output is actually seen, not up front.
		function getOrCreateDestination(name: string): Destination {
			const existing = destinations.get(name);
			if (existing) return existing;
			const filePath = join(dir, `${name}.log`);
			// Rotate any leftover file from a previous run before this run's first write - this is
			// what makes a fresh `braid start` get a clean log instead of one that appends forever.
			rotateFileIfExists(filePath);
			const stream = new SonicBoom({
				dest: filePath,
				append: true,
				// sync:true is load-bearing, not just a perf knob: reopen() only swaps the fd before
				// returning when sync, so the rename-then-reopen rotation sequence below is safe from
				// a concurrent write landing on the stale (just-renamed-away) fd.
				sync: true,
				maxLength: MAX_BUFFERED_BYTES,
			});
			const destination: Destination = { stream, filePath, bytesWritten: 0 };
			destinations.set(name, destination);
			return destination;
		}

		function rotateNow(name: string): void {
			const destination = destinations.get(name);
			if (!destination) return;
			renameSync(destination.filePath, `${destination.filePath}.1`);
			destination.stream.reopen();
			destination.bytesWritten = 0;
		}

		const heartbeat = setInterval(() => {
			for (const set of followers.values()) {
				for (const res of set) res.write("");
			}
		}, HEARTBEAT_INTERVAL_MS);
		heartbeat.unref();

		ctx.on("processOutput", (event) => {
			const destination = getOrCreateDestination(event.name);
			const text = event.chunk.toString();
			destination.stream.write(text);
			destination.bytesWritten += Buffer.byteLength(text);
			if (destination.bytesWritten >= maxSizeBytes) {
				rotateNow(event.name);
			}
			for (const res of followers.get(event.name) ?? []) res.write(text);
			for (const res of followers.get(ALL_PROCESSES_KEY) ?? []) res.write(text);
		});

		ctx.on("processRestart", (event) => {
			getOrCreateDestination(event.name);
			rotateNow(event.name);
		});

		// Critical: without ending open followers here, control-server.ts's close() - which waits
		// for every ACTIVE connection to finish (closeIdleConnections() only clears idle ones) -
		// would hang forever on any open `braid logs --follow` connection, and shutdown() awaits
		// controlServer.close(). This runs before that close() call (both are part of the same
		// daemonShutdown/shutdown sequencing in manager.ts).
		ctx.on("daemonShutdown", () => {
			clearInterval(heartbeat);
			for (const set of followers.values()) {
				for (const res of set) res.end();
				set.clear();
			}
			for (const destination of destinations.values()) destination.stream.end();
		});

		ctx.registerRoute("GET", "/api/logs", (req, res) => {
			const url = new URL(req.url ?? "/", "http://localhost");
			const name = url.searchParams.get("name") ?? undefined;
			const follow = url.searchParams.get("follow") === "true";
			const lines = parseLines(url.searchParams);
			const key = name ?? ALL_PROCESSES_KEY;

			if (name && !ctx.getProcesses().some((p) => p.name === name)) {
				res
					.writeHead(404, { "content-type": "text/plain" })
					.end(`Unknown process "${name}"`);
				return;
			}

			let initial: string;
			if (name) {
				const destination = destinations.get(name);
				initial =
					destination && existsSync(destination.filePath)
						? readFileSync(destination.filePath, "utf8")
						: "";
			} else {
				initial = [...destinations.values()]
					.map((d) =>
						existsSync(d.filePath) ? readFileSync(d.filePath, "utf8") : "",
					)
					.join("");
			}
			if (lines !== undefined) initial = tailLines(initial, lines);

			res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
			// A follow response may have nothing to write for a while (or ever) - flush the headers
			// now rather than let Node hold them until the first body write, so the client's fetch()
			// promise resolves immediately instead of waiting on a chunk that may never come.
			res.flushHeaders();
			if (initial) res.write(initial);

			if (follow) {
				registerFollower(key, res);
			} else {
				res.end();
			}
		});
	},
};
