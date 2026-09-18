import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createControlServer } from "../control-server.js";
import { createPluginContextFactory } from "../plugin-runtime.js";
import { loggerPlugin } from "./logger.js";

const WORKERS = [
	{
		name: "web",
		pid: 111,
		alive: true,
		startedAt: new Date(0).toISOString(),
		restartCount: 0,
	},
	{
		name: "worker",
		pid: 222,
		alive: true,
		startedAt: new Date(0).toISOString(),
		restartCount: 0,
	},
];

async function createHarness(options?: { maxSizeBytes?: number }) {
	const tmpDir = mkdtempSync(join(tmpdir(), "braid-logger-test-"));
	const emitter = new EventEmitter();
	const controlServer = createControlServer();
	const contextFor = createPluginContextFactory({
		controlServer,
		getWorkers: () => WORKERS,
		emitter,
		stopProcess: async () => "ok",
		restartProcess: async () => "ok",
		startProcess: async () => "ok",
	});
	await loggerPlugin.register(contextFor("core:logger"), {
		dir: tmpDir,
		maxSizeBytes: options?.maxSizeBytes,
	});
	const { port } = await controlServer.listen();

	return {
		tmpDir,
		emitter,
		port,
		token: controlServer.token,
		logPath: (name: string) => join(tmpDir, `${name}.log`),
		async cleanup() {
			await controlServer.close();
			rmSync(tmpDir, { recursive: true, force: true });
		},
	};
}

function emitOutput(emitter: EventEmitter, name: string, text: string): void {
	emitter.emit("processOutput", {
		type: "processOutput",
		name,
		stream: "stdout",
		chunk: Buffer.from(text),
	});
}

type HistoryResponse = { lines: string[]; cursor: string | null };

async function fetchHistory(
	h: Awaited<ReturnType<typeof createHarness>>,
	params: {
		name: string;
		lines?: number;
		before?: string | null;
		json?: boolean;
	},
): Promise<{ status: number; body: HistoryResponse | undefined }> {
	const url = new URL(`http://127.0.0.1:${h.port}/api/logs/history`);
	url.searchParams.set("name", params.name);
	if (params.lines !== undefined) {
		url.searchParams.set("lines", String(params.lines));
	}
	if (params.before) url.searchParams.set("before", params.before);
	if (params.json) url.searchParams.set("json", "true");
	const res = await fetch(url, {
		headers: { Authorization: `Bearer ${h.token}` },
	});
	const body = res.ok ? ((await res.json()) as HistoryResponse) : undefined;
	return { status: res.status, body };
}

describe("core:logger plugin", () => {
	it("writes processOutput chunks to a per-process log file", async () => {
		const h = await createHarness();
		emitOutput(h.emitter, "web", "[web] hello\n");
		expect(readFileSync(h.logPath("web"), "utf8")).toBe("[web] hello\n");
		await h.cleanup();
	});

	it("defaults dir to .braid/logs under process.cwd() when no options are given at all", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "braid-logger-cwd-test-"));
		const originalCwd = process.cwd();
		process.chdir(tmpDir);
		try {
			const emitter = new EventEmitter();
			const controlServer = createControlServer();
			const contextFor = createPluginContextFactory({
				controlServer,
				getWorkers: () => WORKERS,
				emitter,
				stopProcess: async () => "ok",
				restartProcess: async () => "ok",
				startProcess: async () => "ok",
			});
			await loggerPlugin.register(contextFor("core:logger"));
			await controlServer.listen();

			emitOutput(emitter, "web", "hello\n");

			expect(
				readFileSync(join(tmpDir, ".braid", "logs", "web.log"), "utf8"),
			).toBe("hello\n");

			await controlServer.close();
		} finally {
			process.chdir(originalCwd);
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("rotates on crossing the size threshold, preserving all bytes across the two files", async () => {
		const h = await createHarness({ maxSizeBytes: 50 });
		const chunk1 = `${"a".repeat(30)}\n`;
		const chunk2 = `${"b".repeat(30)}\n`; // pushes cumulative bytes past 50
		const chunk3 = `${"c".repeat(10)}\n`;

		emitOutput(h.emitter, "web", chunk1);
		emitOutput(h.emitter, "web", chunk2);
		emitOutput(h.emitter, "web", chunk3);

		const rotated = readFileSync(`${h.logPath("web")}.1`, "utf8");
		const active = readFileSync(h.logPath("web"), "utf8");
		expect(rotated).toBe(chunk1 + chunk2);
		expect(active).toBe(chunk3);
		await h.cleanup();
	});

	it("rotates immediately on processRestart, even with no prior output", async () => {
		const h = await createHarness();
		emitOutput(h.emitter, "web", "before restart\n");
		h.emitter.emit("processRestart", { type: "processRestart", name: "web" });
		emitOutput(h.emitter, "web", "after restart\n");

		expect(readFileSync(`${h.logPath("web")}.1`, "utf8")).toBe(
			"before restart\n",
		);
		expect(readFileSync(h.logPath("web"), "utf8")).toBe("after restart\n");
		await h.cleanup();
	});

	it("rotates a fresh run's log instead of appending to a leftover file", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "braid-logger-test-"));
		const emitter = new EventEmitter();
		const controlServer = createControlServer();
		const contextFor = createPluginContextFactory({
			controlServer,
			getWorkers: () => WORKERS,
			emitter,
			stopProcess: async () => "ok",
			restartProcess: async () => "ok",
			startProcess: async () => "ok",
		});

		await loggerPlugin.register(contextFor("core:logger"), { dir: tmpDir });
		await controlServer.listen();
		emitOutput(emitter, "web", "run one\n");
		await controlServer.close();

		// Simulate a fresh `braid start`: a new plugin instance, same log directory.
		const emitter2 = new EventEmitter();
		const controlServer2 = createControlServer();
		const contextFor2 = createPluginContextFactory({
			controlServer: controlServer2,
			getWorkers: () => WORKERS,
			emitter: emitter2,
			stopProcess: async () => "ok",
			restartProcess: async () => "ok",
			startProcess: async () => "ok",
		});
		await loggerPlugin.register(contextFor2("core:logger"), { dir: tmpDir });
		await controlServer2.listen();
		emitOutput(emitter2, "web", "run two\n");

		expect(readFileSync(join(tmpDir, "web.log.1"), "utf8")).toBe("run one\n");
		expect(readFileSync(join(tmpDir, "web.log"), "utf8")).toBe("run two\n");

		await controlServer2.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	describe("GET /api/logs", () => {
		it("returns the current file's contents for a known process", async () => {
			const h = await createHarness();
			emitOutput(h.emitter, "web", "line one\nline two\n");
			const res = await fetch(`http://127.0.0.1:${h.port}/api/logs?name=web`, {
				headers: { Authorization: `Bearer ${h.token}` },
			});
			expect(res.status).toBe(200);
			expect(await res.text()).toBe("line one\nline two\n");
			await h.cleanup();
		});

		it("honors ?lines= to return only the tail", async () => {
			const h = await createHarness();
			emitOutput(h.emitter, "web", "one\ntwo\nthree\nfour\n");
			const res = await fetch(
				`http://127.0.0.1:${h.port}/api/logs?name=web&lines=2`,
				{ headers: { Authorization: `Bearer ${h.token}` } },
			);
			expect(await res.text()).toBe("three\nfour\n");
			await h.cleanup();
		});

		it("returns an empty body for ?lines= against a destination that has never had any content written", async () => {
			const h = await createHarness();
			// Creates a destination (via a restart, not actual output) with nothing ever written to it.
			h.emitter.emit("processRestart", { type: "processRestart", name: "web" });
			const res = await fetch(
				`http://127.0.0.1:${h.port}/api/logs?name=web&lines=5`,
				{ headers: { Authorization: `Bearer ${h.token}` } },
			);
			expect(await res.text()).toBe("");
			await h.cleanup();
		});

		it("ignores an invalid ?lines= value instead of truncating to it", async () => {
			const h = await createHarness();
			emitOutput(h.emitter, "web", "one\ntwo\nthree\n");
			const res = await fetch(
				`http://127.0.0.1:${h.port}/api/logs?name=web&lines=not-a-number`,
				{ headers: { Authorization: `Bearer ${h.token}` } },
			);
			expect(await res.text()).toBe("one\ntwo\nthree\n");
			await h.cleanup();
		});

		it("does not drop the final line of a file with no trailing newline", async () => {
			const h = await createHarness();
			emitOutput(h.emitter, "web", "one\ntwo\nthree");
			const res = await fetch(
				`http://127.0.0.1:${h.port}/api/logs?name=web&lines=2`,
				{ headers: { Authorization: `Bearer ${h.token}` } },
			);
			expect(await res.text()).toBe("two\nthree\n");
			await h.cleanup();
		});

		it("registers a second concurrent follower under the same key alongside the first", async () => {
			const h = await createHarness();
			const res1 = await fetch(
				`http://127.0.0.1:${h.port}/api/logs?name=web&follow=true`,
				{ headers: { Authorization: `Bearer ${h.token}` } },
			);
			const res2 = await fetch(
				`http://127.0.0.1:${h.port}/api/logs?name=web&follow=true`,
				{ headers: { Authorization: `Bearer ${h.token}` } },
			);
			const reader1 = res1.body?.getReader();
			const reader2 = res2.body?.getReader();
			if (!reader1 || !reader2) {
				throw new Error("expected readable response bodies");
			}

			emitOutput(h.emitter, "web", "broadcast\n");
			const [chunk1, chunk2] = await Promise.all([
				reader1.read(),
				reader2.read(),
			]);
			expect(Buffer.from(chunk1.value ?? new Uint8Array()).toString()).toBe(
				"broadcast\n",
			);
			expect(Buffer.from(chunk2.value ?? new Uint8Array()).toString()).toBe(
				"broadcast\n",
			);

			h.emitter.emit("daemonShutdown", { type: "daemonShutdown" });
			await h.cleanup();
		});

		it("interleaves every process's file when no name is given", async () => {
			const h = await createHarness();
			emitOutput(h.emitter, "web", "[web] a\n");
			emitOutput(h.emitter, "worker", "[worker] b\n");
			const res = await fetch(`http://127.0.0.1:${h.port}/api/logs`, {
				headers: { Authorization: `Bearer ${h.token}` },
			});
			const body = await res.text();
			expect(body).toContain("[web] a\n");
			expect(body).toContain("[worker] b\n");
			await h.cleanup();
		});

		it("skips a destination whose own file has since been removed from disk, when interleaving", async () => {
			const h = await createHarness();
			emitOutput(h.emitter, "web", "[web] a\n");
			emitOutput(h.emitter, "worker", "[worker] b\n");
			rmSync(h.logPath("worker"), { force: true });

			const res = await fetch(`http://127.0.0.1:${h.port}/api/logs`, {
				headers: { Authorization: `Bearer ${h.token}` },
			});
			const body = await res.text();
			expect(body).toContain("[web] a\n");
			expect(body).not.toContain("[worker] b\n");
			await h.cleanup();
		});

		it("404s an unknown process name", async () => {
			const h = await createHarness();
			const res = await fetch(`http://127.0.0.1:${h.port}/api/logs?name=nope`, {
				headers: { Authorization: `Bearer ${h.token}` },
			});
			expect(res.status).toBe(404);
			await h.cleanup();
		});

		it("treats an explicit but empty ?name= the same as an omitted one for a follow request", async () => {
			const h = await createHarness();
			const res = await fetch(
				`http://127.0.0.1:${h.port}/api/logs?name=&follow=true`,
				{ headers: { Authorization: `Bearer ${h.token}` } },
			);
			expect(res.status).toBe(200);
			const reader = res.body?.getReader();
			if (!reader) throw new Error("expected a readable response body");

			// The real regression: this connection must be registered under the same follower key an
			// omitted `name` would use, not the literal empty string (which nothing ever dispatches
			// to, leaving it a dead connection open until shutdown) - proven by it actually receiving
			// output emitted after the request.
			emitOutput(h.emitter, "web", "live chunk\n");
			const { value, done } = await reader.read();
			expect(done).toBe(false);
			expect(Buffer.from(value ?? new Uint8Array()).toString()).toBe(
				"live chunk\n",
			);

			h.emitter.emit("daemonShutdown", { type: "daemonShutdown" });
			await h.cleanup();
		});

		it("streams live processOutput chunks to a follow request", async () => {
			const h = await createHarness();
			const res = await fetch(
				`http://127.0.0.1:${h.port}/api/logs?name=web&follow=true`,
				{ headers: { Authorization: `Bearer ${h.token}` } },
			);
			const reader = res.body?.getReader();
			if (!reader) throw new Error("expected a readable response body");

			emitOutput(h.emitter, "web", "live chunk\n");
			const { value, done } = await reader.read();
			expect(done).toBe(false);
			expect(Buffer.from(value ?? new Uint8Array()).toString()).toBe(
				"live chunk\n",
			);

			h.emitter.emit("daemonShutdown", { type: "daemonShutdown" });
			await h.cleanup();
		});

		it("ends open followers on daemonShutdown instead of hanging control-server.close()", async () => {
			const h = await createHarness();
			const res = await fetch(
				`http://127.0.0.1:${h.port}/api/logs?name=web&follow=true`,
				{ headers: { Authorization: `Bearer ${h.token}` } },
			);
			const reader = res.body?.getReader();
			if (!reader) throw new Error("expected a readable response body");

			h.emitter.emit("daemonShutdown", { type: "daemonShutdown" });

			const result = await Promise.race([
				reader.read(),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("follower was not ended")), 2000),
				),
			]);
			expect(result.done).toBe(true);

			// The real regression this guards: close() must not hang with an (now-ended) follower.
			await h.cleanup();
		}, 5000);

		it("keeps an idle follow connection alive across a heartbeat tick", async () => {
			vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
			try {
				const h = await createHarness();
				const res = await fetch(
					`http://127.0.0.1:${h.port}/api/logs?name=web&follow=true`,
					{ headers: { Authorization: `Bearer ${h.token}` } },
				);
				const reader = res.body?.getReader();
				if (!reader) throw new Error("expected a readable response body");

				// Fires the heartbeat's empty write to every registered follower - the real assertion
				// is simply that this doesn't throw or otherwise break the connection.
				await vi.advanceTimersByTimeAsync(20_000);

				emitOutput(h.emitter, "web", "still alive\n");
				const { value, done } = await reader.read();
				expect(done).toBe(false);
				expect(Buffer.from(value ?? new Uint8Array()).toString()).toBe(
					"still alive\n",
				);

				h.emitter.emit("daemonShutdown", { type: "daemonShutdown" });
				await h.cleanup();
			} finally {
				vi.useRealTimers();
			}
		});

		describe("?json=true", () => {
			it("returns one ndjson line per log line, ANSI stripped, for a known process", async () => {
				const h = await createHarness();
				emitOutput(h.emitter, "web", "\x1b[34m[web]\x1b[0m one\nplain two\n");
				const res = await fetch(
					`http://127.0.0.1:${h.port}/api/logs?name=web&json=true`,
					{ headers: { Authorization: `Bearer ${h.token}` } },
				);
				expect(res.headers.get("content-type")).toContain(
					"application/x-ndjson",
				);
				const body = await res.text();
				expect(
					body
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line)),
				).toEqual([
					{ name: "web", text: "[web] one" },
					{ name: "web", text: "plain two" },
				]);
				await h.cleanup();
			});

			it("honors ?lines= against the ndjson output the same as the plain-text route", async () => {
				const h = await createHarness();
				emitOutput(h.emitter, "web", "one\ntwo\nthree\nfour\n");
				const res = await fetch(
					`http://127.0.0.1:${h.port}/api/logs?name=web&json=true&lines=2`,
					{ headers: { Authorization: `Bearer ${h.token}` } },
				);
				const lines = (await res.text())
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line));
				expect(lines).toEqual([
					{ name: "web", text: "three" },
					{ name: "web", text: "four" },
				]);
				await h.cleanup();
			});

			it("tags each line with its own process's real name when interleaving (no ?name= given)", async () => {
				const h = await createHarness();
				emitOutput(h.emitter, "web", "a\n");
				emitOutput(h.emitter, "worker", "b\n");
				const res = await fetch(
					`http://127.0.0.1:${h.port}/api/logs?json=true`,
					{ headers: { Authorization: `Bearer ${h.token}` } },
				);
				const lines = (await res.text())
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line));
				expect(lines).toContainEqual({ name: "web", text: "a" });
				expect(lines).toContainEqual({ name: "worker", text: "b" });
				await h.cleanup();
			});

			it("streams live output as framed, ANSI-stripped ndjson to a follow request", async () => {
				const h = await createHarness();
				const res = await fetch(
					`http://127.0.0.1:${h.port}/api/logs?name=web&json=true&follow=true`,
					{ headers: { Authorization: `Bearer ${h.token}` } },
				);
				const reader = res.body?.getReader();
				if (!reader) throw new Error("expected a readable response body");

				emitOutput(h.emitter, "web", "\x1b[32mlive\x1b[0m line\n");
				const { value } = await reader.read();
				expect(
					JSON.parse(Buffer.from(value ?? new Uint8Array()).toString()),
				).toEqual({ name: "web", text: "live line" });

				h.emitter.emit("daemonShutdown", { type: "daemonShutdown" });
				await h.cleanup();
			});

			it("buffers a line split across two chunks instead of framing it as two partial lines", async () => {
				const h = await createHarness();
				const res = await fetch(
					`http://127.0.0.1:${h.port}/api/logs?name=web&json=true&follow=true`,
					{ headers: { Authorization: `Bearer ${h.token}` } },
				);
				const reader = res.body?.getReader();
				if (!reader) throw new Error("expected a readable response body");

				// Two chunks, neither a complete line on its own - the split must wait for the "\n".
				emitOutput(h.emitter, "web", "partial-");
				emitOutput(h.emitter, "web", "line\nsecond\n");
				const chunk = Buffer.from(
					(await reader.read()).value ?? new Uint8Array(),
				).toString();
				const lines = chunk
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line));
				expect(lines).toEqual([
					{ name: "web", text: "partial-line" },
					{ name: "web", text: "second" },
				]);

				h.emitter.emit("daemonShutdown", { type: "daemonShutdown" });
				await h.cleanup();
			});

			it("gives a plain-text follower raw bytes and a json follower framed lines from the same event", async () => {
				const h = await createHarness();
				const plainRes = await fetch(
					`http://127.0.0.1:${h.port}/api/logs?name=web&follow=true`,
					{ headers: { Authorization: `Bearer ${h.token}` } },
				);
				const jsonRes = await fetch(
					`http://127.0.0.1:${h.port}/api/logs?name=web&json=true&follow=true`,
					{ headers: { Authorization: `Bearer ${h.token}` } },
				);
				const plainReader = plainRes.body?.getReader();
				const jsonReader = jsonRes.body?.getReader();
				if (!plainReader || !jsonReader) {
					throw new Error("expected readable response bodies");
				}

				emitOutput(h.emitter, "web", "shared\n");
				const [plainChunk, jsonChunk] = await Promise.all([
					plainReader.read(),
					jsonReader.read(),
				]);
				expect(
					Buffer.from(plainChunk.value ?? new Uint8Array()).toString(),
				).toBe("shared\n");
				expect(
					JSON.parse(
						Buffer.from(jsonChunk.value ?? new Uint8Array()).toString(),
					),
				).toEqual({ name: "web", text: "shared" });

				h.emitter.emit("daemonShutdown", { type: "daemonShutdown" });
				await h.cleanup();
			});
		});
	});

	describe("GET /api/logs/history", () => {
		it("404s an unknown process name", async () => {
			const h = await createHarness();
			const { status } = await fetchHistory(h, { name: "nope" });
			expect(status).toBe(404);
			await h.cleanup();
		});

		it("treats a malformed ?before= cursor as no cursor at all rather than erroring", async () => {
			const h = await createHarness();
			emitOutput(h.emitter, "web", "one\ntwo\n");
			const res = await fetch(
				`http://127.0.0.1:${h.port}/api/logs/history?name=web&before=not-a-real-cursor`,
				{ headers: { Authorization: `Bearer ${h.token}` } },
			);
			expect(res.status).toBe(200);
			const body = (await res.json()) as HistoryResponse;
			expect(body.lines).toEqual(["one", "two"]);
			await h.cleanup();
		});

		it("returns no lines and a null cursor for a known process with no log yet", async () => {
			const h = await createHarness();
			const { status, body } = await fetchHistory(h, { name: "web" });
			expect(status).toBe(200);
			expect(body).toEqual({ lines: [], cursor: null });
			await h.cleanup();
		});

		it("does not drop the final line of a file with no trailing newline", async () => {
			const h = await createHarness();
			emitOutput(h.emitter, "web", "one\ntwo\nthree");
			const { body } = await fetchHistory(h, { name: "web", lines: 2 });
			expect(body?.lines).toEqual(["two", "three"]);
			await h.cleanup();
		});

		it("strips ANSI codes from each line when ?json=true, keeping the same {lines,cursor} shape", async () => {
			const h = await createHarness();
			emitOutput(h.emitter, "web", "\x1b[34m[web]\x1b[0m one\nplain two\n");
			const { body } = await fetchHistory(h, { name: "web", json: true });
			expect(body?.lines).toEqual(["[web] one", "plain two"]);
			await h.cleanup();
		});

		it("pages backward through a single file via the returned cursor, ending at a null cursor", async () => {
			const h = await createHarness();
			emitOutput(h.emitter, "web", "one\ntwo\nthree\nfour\nfive\n");

			const page1 = await fetchHistory(h, { name: "web", lines: 2 });
			expect(page1.body?.lines).toEqual(["four", "five"]);
			expect(page1.body?.cursor).not.toBeNull();

			const page2 = await fetchHistory(h, {
				name: "web",
				lines: 2,
				before: page1.body?.cursor,
			});
			expect(page2.body?.lines).toEqual(["two", "three"]);
			expect(page2.body?.cursor).not.toBeNull();

			const page3 = await fetchHistory(h, {
				name: "web",
				lines: 2,
				before: page2.body?.cursor,
			});
			expect(page3.body?.lines).toEqual(["one"]);
			expect(page3.body?.cursor).toBeNull();

			await h.cleanup();
		});

		it("re-targets a cursor into the backup file when a rotation happens between calls", async () => {
			const h = await createHarness();
			emitOutput(h.emitter, "web", "old one\nold two\nold three\n");
			const before = await fetchHistory(h, { name: "web", lines: 2 });
			expect(before.body?.lines).toEqual(["old two", "old three"]);

			// Rotates "current" (holding the 3 lines above) into ".1" and starts a fresh "current".
			h.emitter.emit("processRestart", { type: "processRestart", name: "web" });
			emitOutput(h.emitter, "web", "new one\n");

			const after = await fetchHistory(h, {
				name: "web",
				lines: 2,
				before: before.body?.cursor,
			});
			// The cursor was minted one generation ago against what's now the backup file - it must
			// still resolve to "old one" (the line before what page 1 already returned), not to
			// content from the unrelated fresh "current" file the rotation started.
			expect(after.body?.lines).toEqual(["old one"]);
			expect(after.body?.cursor).toBeNull();

			await h.cleanup();
		});

		it("falls back to the backup file on the very first fetch when current alone doesn't fill a page", async () => {
			const h = await createHarness();
			emitOutput(h.emitter, "web", "old one\nold two\nold three\n");
			h.emitter.emit("processRestart", { type: "processRestart", name: "web" });
			emitOutput(h.emitter, "web", "new one\n");

			// "current" only has the one line above - fewer than the requested page size - so the
			// rest of the page must come from the backup file the rotation just created instead of
			// silently returning a short page with no way to page further back.
			const { body } = await fetchHistory(h, { name: "web", lines: 2 });
			expect(body?.lines).toEqual(["new one"]);
			expect(body?.cursor).not.toBeNull();

			const next = await fetchHistory(h, {
				name: "web",
				lines: 2,
				before: body?.cursor,
			});
			expect(next.body?.lines).toEqual(["old two", "old three"]);

			await h.cleanup();
		});

		it("continues pagination into the backup file once a valid 'current' cursor's own range is exhausted", async () => {
			const h = await createHarness();
			emitOutput(h.emitter, "web", "old one\nold two\nold three\n");
			h.emitter.emit("processRestart", { type: "processRestart", name: "web" });
			emitOutput(h.emitter, "web", "new one\nnew two\nnew three\n");

			const page1 = await fetchHistory(h, { name: "web", lines: 2 });
			expect(page1.body?.lines).toEqual(["new two", "new three"]);

			// The cursor points partway into "current" (still the same generation, no new rotation) -
			// paging back from there only has one more line available in "current" itself; the rest
			// of this page's room must be filled by continuing into the backup file, not just handed
			// back short.
			const page2 = await fetchHistory(h, {
				name: "web",
				lines: 2,
				before: page1.body?.cursor,
			});
			expect(page2.body?.lines).toEqual(["new one"]);
			expect(page2.body?.cursor).not.toBeNull();

			const page3 = await fetchHistory(h, {
				name: "web",
				lines: 2,
				before: page2.body?.cursor,
			});
			expect(page3.body?.lines).toEqual(["old two", "old three"]);

			await h.cleanup();
		});

		it("returns nothing further for a 'backup' cursor stale by more than one generation", async () => {
			const h = await createHarness();
			emitOutput(h.emitter, "web", "gen0 one\ngen0 two\n");
			h.emitter.emit("processRestart", { type: "processRestart", name: "web" });
			emitOutput(h.emitter, "web", "gen1 one\n");

			// current has just one line - falls back to backup (generation 1), same shape as the
			// "falls back to the backup file on the very first fetch" test above.
			const cursor1 = await fetchHistory(h, { name: "web", lines: 1 });
			expect(cursor1.body?.cursor).toContain("backup:1:");

			// Two more rotations move the backup file's own generation on twice more, well past
			// what cursor1 was minted against.
			h.emitter.emit("processRestart", { type: "processRestart", name: "web" });
			emitOutput(h.emitter, "web", "gen2 one\n");
			h.emitter.emit("processRestart", { type: "processRestart", name: "web" });
			emitOutput(h.emitter, "web", "gen3 one\n");

			const after = await fetchHistory(h, {
				name: "web",
				lines: 1,
				before: cursor1.body?.cursor,
			});
			expect(after.body).toEqual({ lines: [], cursor: null });

			await h.cleanup();
		});

		it("returns nothing further for a cursor stale by more than one generation", async () => {
			const h = await createHarness();
			emitOutput(h.emitter, "web", "old one\nold two\n");
			const before = await fetchHistory(h, { name: "web", lines: 1 });
			expect(before.body?.cursor).not.toBeNull();

			h.emitter.emit("processRestart", { type: "processRestart", name: "web" });
			emitOutput(h.emitter, "web", "middle\n");
			h.emitter.emit("processRestart", { type: "processRestart", name: "web" });
			emitOutput(h.emitter, "web", "new\n");

			const after = await fetchHistory(h, {
				name: "web",
				before: before.body?.cursor,
			});
			expect(after.body).toEqual({ lines: [], cursor: null });

			await h.cleanup();
		});

		it("re-targets a cursor minted from a stale on-disk file (no Destination yet this run) into the backup that file rotates into on first output", async () => {
			const h = await createHarness();
			// Simulates a previous daemon run's log this process hasn't written to yet this run -
			// no Destination exists for "web" until its first processOutput event, so this file sits
			// untouched (and unrotated) right up until that happens.
			writeFileSync(
				h.logPath("web"),
				"stale one\nstale two\nstale three\nstale four\nstale five\n",
			);

			// Minted while no Destination exists yet: currentGeneration falls back to 0.
			const before = await fetchHistory(h, { name: "web", lines: 3 });
			expect(before.body?.lines).toEqual([
				"stale three",
				"stale four",
				"stale five",
			]);

			// First output for "web" this run: lazily creates the Destination, rotating the stale
			// file into ".1" - this must count as a generation bump, since the cursor above was
			// minted against content that's now living in the backup file, not a fresh generation 0.
			emitOutput(h.emitter, "web", "fresh output\n");

			const after = await fetchHistory(h, {
				name: "web",
				lines: 3,
				before: before.body?.cursor,
			});
			expect(after.body?.lines).toEqual(["stale one", "stale two"]);
			expect(after.body?.cursor).toBeNull();

			await h.cleanup();
		});
	});
});
