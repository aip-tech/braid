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
	/** Set once daemonShutdown has called stream.end() on it - SonicBoom finishes destroying
	 *  itself asynchronously, so a still-running process's own output can otherwise arrive in the
	 *  gap and throw "SonicBoom destroyed" trying to write to it. */
	ended: boolean;
	/**
	 * Bumped on every rotation - lets a `/api/logs/history` cursor (which embeds the generation it
	 * was issued under) detect whether "current"/"backup" still mean what they meant when the
	 * client last asked, without a stat()-based staleness check that would false-positive on every
	 * ordinary append (see the history route below for how a one-generation gap is reinterpreted).
	 */
	generation: number;
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

// Default page size for /api/logs/history when the client omits `lines`.
const DEFAULT_HISTORY_PAGE_LINES = 300;

/** A `/api/logs/history` pagination cursor: "lines before index `lineIndex` in `file` (as of
 *  `generation`) haven't been returned yet." Opaque to the client, round-tripped verbatim. */
type HistoryCursor = {
	file: "current" | "backup";
	generation: number;
	lineIndex: number;
};

function encodeCursor(cursor: HistoryCursor): string {
	return `${cursor.file}:${cursor.generation}:${cursor.lineIndex}`;
}

function parseCursor(raw: string | null): HistoryCursor | undefined {
	if (!raw) return undefined;
	const match = /^(current|backup):(\d+):(\d+)$/.exec(raw);
	if (!match) return undefined;
	return {
		file: match[1] as "current" | "backup",
		generation: Number.parseInt(match[2], 10),
		lineIndex: Number.parseInt(match[3], 10),
	};
}

function readLogLines(filePath: string): string[] {
	if (!existsSync(filePath)) return [];
	const lines = readFileSync(filePath, "utf8").split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines;
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
			const destination: Destination = {
				stream,
				filePath,
				bytesWritten: 0,
				ended: false,
				generation: 0,
			};
			destinations.set(name, destination);
			return destination;
		}

		function rotateNow(name: string): void {
			const destination = destinations.get(name);
			if (!destination) return;
			renameSync(destination.filePath, `${destination.filePath}.1`);
			destination.stream.reopen();
			destination.bytesWritten = 0;
			destination.generation += 1;
		}

		const heartbeat = setInterval(() => {
			for (const set of followers.values()) {
				for (const res of set) res.write("");
			}
		}, HEARTBEAT_INTERVAL_MS);
		heartbeat.unref();

		ctx.on("processOutput", (event) => {
			const destination = getOrCreateDestination(event.name);
			// Once shutting down, there's nowhere useful left to persist this to anyway.
			if (destination.ended) return;
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
			for (const destination of destinations.values()) {
				destination.ended = true;
				destination.stream.end();
			}
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

		// Paginated *older* history, separate from the route above (which stays exactly as-is for
		// `braid logs --follow` compatibility): the UI loads its initial view and any "scroll up for
		// more" pages from here, then only uses the plain route's `follow=true` for the live tail
		// going forward. JSON, not a kept-open stream - each call answers once and closes.
		ctx.registerRoute("GET", "/api/logs/history", (req, res) => {
			const url = new URL(req.url ?? "/", "http://localhost");
			const name = url.searchParams.get("name");
			const pageSize =
				parseLines(url.searchParams) ?? DEFAULT_HISTORY_PAGE_LINES;

			if (!name || !ctx.getProcesses().some((p) => p.name === name)) {
				res
					.writeHead(404, { "content-type": "text/plain" })
					.end(`Unknown process "${name}"`);
				return;
			}

			function respond(lines: string[], cursor: HistoryCursor | null): void {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						lines,
						cursor: cursor ? encodeCursor(cursor) : null,
					}),
				);
			}

			const destination = destinations.get(name);
			const currentGeneration = destination?.generation ?? 0;
			const currentPath = destination?.filePath ?? join(dir, `${name}.log`);
			const backupPath = `${currentPath}.1`;

			const cursor = parseCursor(url.searchParams.get("before"));

			if (!cursor) {
				const lines = readLogLines(currentPath);
				const page = lines.slice(-pageSize);
				const consumedFrom = lines.length - page.length;
				if (consumedFrom > 0) {
					respond(page, {
						file: "current",
						generation: currentGeneration,
						lineIndex: consumedFrom,
					});
				} else if (existsSync(backupPath)) {
					respond(page, {
						file: "backup",
						generation: currentGeneration,
						lineIndex: readLogLines(backupPath).length,
					});
				} else {
					respond(page, null);
				}
				return;
			}

			// A cursor only means what it says as of the generation it was issued under - a rotation
			// renames "current" to "backup" (replacing whatever backup existed), so a cursor still
			// pointing at "current" one generation back now refers to what's *become* "backup" (same
			// bytes, same line indices, just renamed) - reinterpreted below rather than served as
			// though nothing happened. Anything staler than that (two+ rotations since the cursor was
			// issued, or a "backup" cursor whose generation no longer matches) refers to content
			// that's genuinely gone - answered as "nothing more" rather than risking wrong data.
			let targetFile = cursor.file;
			if (
				cursor.file === "current" &&
				cursor.generation !== currentGeneration
			) {
				if (cursor.generation === currentGeneration - 1) {
					targetFile = "backup";
				} else {
					respond([], null);
					return;
				}
			} else if (
				cursor.file === "backup" &&
				cursor.generation !== currentGeneration
			) {
				respond([], null);
				return;
			}

			const targetPath = targetFile === "current" ? currentPath : backupPath;
			const lines = readLogLines(targetPath);
			const endIndex = Math.min(cursor.lineIndex, lines.length);
			const startIndex = Math.max(0, endIndex - pageSize);
			const page = lines.slice(startIndex, endIndex);

			if (startIndex > 0) {
				respond(page, {
					file: targetFile,
					generation: currentGeneration,
					lineIndex: startIndex,
				});
			} else if (targetFile === "current" && existsSync(backupPath)) {
				respond(page, {
					file: "backup",
					generation: currentGeneration,
					lineIndex: readLogLines(backupPath).length,
				});
			} else {
				respond(page, null);
			}
		});
	},
};
