import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import SonicBoom from "sonic-boom";
import { DEFAULT_LOG_MAX_SIZE_BYTES } from "../config.js";
import { stripAnsi } from "../prefix.js";
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
	/** Buffers a chunk that might end mid-line, so a `json` follower only ever gets whole lines to
	 *  frame - a raw stdout/stderr chunk from the OS pipe isn't guaranteed to align with the
	 *  complete-line writes `linePrefixer` made on the sending side. Plain-text followers and the
	 *  persisted file don't need this: they just relay/append bytes as they arrive, line boundaries
	 *  irrelevant. Only ever updated while at least one `json` follower exists for this name (see
	 *  the processOutput handler) - nothing is lost by not tracking it while nobody's watching that
	 *  way, since a newly-connecting json follower only cares about lines from here on anyway. */
	jsonPendingLine: string;
};

/** A live `/api/logs?follow=true` subscriber - `json` picked per-connection (via its own `?json=`
 *  query param), so a plain-text and a `json` client watching the same process each get correctly
 *  different framing from the same underlying output. */
type Follower = { res: ServerResponse; json: boolean };

/** Renames `filePath` to `${filePath}.1` if it exists, and reports whether it did. */
function rotateFileIfExists(filePath: string): boolean {
	if (existsSync(filePath)) {
		renameSync(filePath, `${filePath}.1`);
		return true;
	}
	return false;
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
		const followers = new Map<string, Set<Follower>>();

		function getFollowerSet(key: string): Set<Follower> {
			let set = followers.get(key);
			if (!set) {
				set = new Set();
				followers.set(key, set);
			}
			return set;
		}

		function registerFollower(key: string, follower: Follower): void {
			const set = getFollowerSet(key);
			set.add(follower);
			follower.res.on("close", () => set.delete(follower));
			// istanbul ignore next -- symmetric cleanup for the same set entry 'close' above already
			// removes; reliably forcing a real 'error' (as opposed to a client-initiated 'close', which
			// is what an aborted fetch/dropped connection actually produces and is covered above)
			// needs a genuinely broken socket, not something a test can construct deterministically
			// without flaking.
			follower.res.on("error", () => set.delete(follower));
		}

		/** All current followers of `name`, whether registered by that exact name or via the
		 *  "every process interleaved" bucket. */
		function followersFor(name: string): Follower[] {
			return [
				...(followers.get(name) ?? []),
				...(followers.get(ALL_PROCESSES_KEY) ?? []),
			];
		}

		/** Splits `chunk` on `destination`'s own pending-partial-line buffer, returning only the
		 *  now-complete lines and carrying the trailing partial (if any) forward. */
		function splitCompleteLines(
			destination: Destination,
			chunk: string,
		): string[] {
			const combined = destination.jsonPendingLine + chunk;
			const parts = combined.split("\n");
			// istanbul ignore next -- String.split always returns at least one element, so pop() here
			// can never actually be undefined.
			destination.jsonPendingLine = parts.pop() ?? "";
			return parts;
		}

		// Created lazily on first output, not at register() time, since no process has forked yet.
		function getOrCreateDestination(name: string): Destination {
			const existing = destinations.get(name);
			if (existing) return existing;
			const filePath = join(dir, `${name}.log`);
			// A file already at this path predates this Destination (a previous daemon run's output
			// that was never rotated because nothing wrote here yet this run) - rotating it away
			// here is itself a generation bump. Starting fresh at generation 0 instead would make a
			// `/api/logs/history` cursor minted *before* this call (reading that stale file with no
			// Destination yet, so `currentGeneration` was 0 by fallback - see the history route
			// below) compare equal to this brand new destination's own generation 0, wrongly reading
			// the new, unrelated file instead of being redirected to the backup the stale content
			// actually rotated into.
			const rotated = rotateFileIfExists(filePath);
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
				generation: rotated ? 1 : 0,
				jsonPendingLine: "",
			};
			destinations.set(name, destination);
			return destination;
		}

		function rotateNow(name: string): void {
			const destination = destinations.get(name);
			// istanbul ignore if -- both call sites (the processOutput size-threshold check and the
			// processRestart handler, which calls getOrCreateDestination first) only ever reach this
			// after a destination for `name` already exists.
			if (!destination) return;
			renameSync(destination.filePath, `${destination.filePath}.1`);
			destination.stream.reopen();
			destination.bytesWritten = 0;
			destination.generation += 1;
		}

		const heartbeat = setInterval(() => {
			for (const set of followers.values()) {
				for (const follower of set) follower.res.write("");
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

			const relevant = followersFor(event.name);
			// json followers all share one lazily-computed split of this same chunk, computed at
			// most once regardless of how many json followers are watching - see splitCompleteLines.
			let framedLines: string[] | undefined;
			for (const follower of relevant) {
				if (!follower.json) {
					follower.res.write(text);
					continue;
				}
				framedLines ??= splitCompleteLines(destination, text).map(
					(line) =>
						`${JSON.stringify({ name: event.name, text: stripAnsi(line) })}\n`,
				);
				for (const framed of framedLines) follower.res.write(framed);
			}
		});

		ctx.on("processRestart", (event) => {
			getOrCreateDestination(event.name);
			rotateNow(event.name);
		});

		// Ending followers here matters: an open one would otherwise hang controlServer.close().
		ctx.on("daemonShutdown", () => {
			clearInterval(heartbeat);
			for (const set of followers.values()) {
				for (const follower of set) follower.res.end();
				set.clear();
			}
			for (const destination of destinations.values()) {
				destination.ended = true;
				destination.stream.end();
			}
		});

		ctx.registerRoute("GET", "/api/logs", (req, res) => {
			// istanbul ignore next -- `req.url` satisfies IncomingMessage's own optional typing;
			// Node's HTTP parser never emits a 'request' event without it already set (same
			// reasoning as control-server.ts's own identical fallbacks).
			const url = new URL(req.url ?? "/", "http://localhost");
			// `|| undefined`, not `?? undefined` - an explicit but empty `?name=` must be treated the
			// same as an omitted one everywhere below (the unknown-process check, which follower key
			// a `follow=true` connection registers under, and which log content is served), not just
			// by the falsy-name branches that already happen to read right. `??` alone would leave
			// `name` as "" (a string, not null/undefined), landing this connection under a follower
			// key nothing ever dispatches to - a dead connection, held open until shutdown.
			const name = url.searchParams.get("name") || undefined;
			const follow = url.searchParams.get("follow") === "true";
			const lines = parseLines(url.searchParams);
			const json = url.searchParams.get("json") === "true";
			const key = name ?? ALL_PROCESSES_KEY;

			if (name && !ctx.getProcesses().some((p) => p.name === name)) {
				res
					.writeHead(404, { "content-type": "text/plain" })
					.end(`Unknown process "${name}"`);
				return;
			}

			if (json) {
				// Built from each destination's own lines (tagged with its real name) rather than
				// concatenating raw file text and splitting afterwards, the way the plain-text branch
				// below does - by the time text from multiple processes is joined into one string,
				// which portion came from which process is already lost. Same (Map-insertion) process
				// order as the plain-text branch for the no-name case - not chronologically
				// interleaved there either, an existing property of this route, not a regression.
				let jsonLines: Array<{ name: string; text: string }>;
				if (name) {
					const destination = destinations.get(name);
					jsonLines = (
						destination ? readLogLines(destination.filePath) : []
					).map((line) => ({ name, text: stripAnsi(line) }));
				} else {
					jsonLines = [...destinations].flatMap(([destName, destination]) =>
						readLogLines(destination.filePath).map((line) => ({
							name: destName,
							text: stripAnsi(line),
						})),
					);
				}
				if (lines !== undefined) jsonLines = jsonLines.slice(-lines);

				res.writeHead(200, {
					"content-type": "application/x-ndjson; charset=utf-8",
				});
				res.flushHeaders();
				for (const line of jsonLines) res.write(`${JSON.stringify(line)}\n`);

				if (follow) {
					registerFollower(key, { res, json: true });
				} else {
					res.end();
				}
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
				registerFollower(key, { res, json: false });
			} else {
				res.end();
			}
		});

		// Paginated *older* history, separate from the route above (which stays exactly as-is for
		// `braid logs --follow` compatibility): the UI loads its initial view and any "scroll up for
		// more" pages from here, then only uses the plain route's `follow=true` for the live tail
		// going forward. JSON, not a kept-open stream - each call answers once and closes.
		ctx.registerRoute("GET", "/api/logs/history", (req, res) => {
			// istanbul ignore next -- same reasoning as the /api/logs route's identical fallback above.
			const url = new URL(req.url ?? "/", "http://localhost");
			const name = url.searchParams.get("name");
			const pageSize =
				parseLines(url.searchParams) ?? DEFAULT_HISTORY_PAGE_LINES;
			const json = url.searchParams.get("json") === "true";

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
						// `json` here only means "clean, ANSI-free text for a scripting consumer" - this
						// route is already always JSON, and already scoped to one `name`, so there's no
						// per-line name to attach the way the interleaved /api/logs route needs.
						lines: json ? lines.map(stripAnsi) : lines,
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
