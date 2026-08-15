import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import SonicBoom from "sonic-boom";
import { DEFAULT_LOG_MAX_SIZE_BYTES } from "../config.js";
import type { BraidPlugin } from "../types.js";

type LoggerOptions = { dir?: string; maxSizeBytes?: number };
// sonic-boom's own backpressure ceiling - a safety net against unbounded buffering, not rotation.
const MAX_BUFFERED_BYTES = 10 * 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 20_000;
// Follower bucket key for the "all processes, interleaved" route.
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

export const loggerPlugin: BraidPlugin = {
	name: "core:logger",
	register(ctx, rawOptions) {
		const options = (rawOptions ?? {}) as LoggerOptions;
		const dir = options.dir ?? join(process.cwd(), ".braid", "logs");
		const maxSizeBytes = options.maxSizeBytes ?? DEFAULT_LOG_MAX_SIZE_BYTES;
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

		// Created lazily on first output, not at register() time, since no process has forked yet.
		function getOrCreateDestination(name: string): Destination {
			const existing = destinations.get(name);
			if (existing) return existing;
			const filePath = join(dir, `${name}.log`);
			rotateFileIfExists(filePath);
			const stream = new SonicBoom({
				dest: filePath,
				append: true,
				// Required for reopen() to be safe for rotation (fd swap completes before it returns).
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

		// Ending followers here matters: an open one would otherwise hang controlServer.close().
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
			// Without this, Node holds the headers until the first body write, which may never come.
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
