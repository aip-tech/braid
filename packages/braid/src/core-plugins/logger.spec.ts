import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createControlServer } from "../control-server.js";
import { createPluginContextFactory } from "../plugin-runtime.js";
import { loggerPlugin } from "./logger.js";

const WORKERS = [
	{ name: "web", pid: 111, alive: true, startedAt: new Date(0).toISOString() },
	{
		name: "worker",
		pid: 222,
		alive: true,
		startedAt: new Date(0).toISOString(),
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

describe("core:logger plugin", () => {
	it("writes processOutput chunks to a per-process log file", async () => {
		const h = await createHarness();
		emitOutput(h.emitter, "web", "[web] hello\n");
		expect(readFileSync(h.logPath("web"), "utf8")).toBe("[web] hello\n");
		await h.cleanup();
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

		it("404s an unknown process name", async () => {
			const h = await createHarness();
			const res = await fetch(`http://127.0.0.1:${h.port}/api/logs?name=nope`, {
				headers: { Authorization: `Bearer ${h.token}` },
			});
			expect(res.status).toBe(404);
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
	});
});
