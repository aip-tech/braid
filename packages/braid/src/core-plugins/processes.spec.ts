import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createControlServer } from "../control-server.js";
import { createPluginContextFactory } from "../plugin-runtime.js";
import type { ProcessActionResult } from "../types.js";
import { processesPlugin } from "./processes.js";

async function createHarness(actions?: {
	stopProcess?: (name: string) => Promise<ProcessActionResult>;
	restartProcess?: (name: string) => Promise<ProcessActionResult>;
	startProcess?: (name: string) => Promise<ProcessActionResult>;
}) {
	const controlServer = createControlServer();
	const stopProcess = actions?.stopProcess ?? vi.fn(async () => "ok" as const);
	const restartProcess =
		actions?.restartProcess ?? vi.fn(async () => "ok" as const);
	const startProcess =
		actions?.startProcess ?? vi.fn(async () => "ok" as const);
	const contextFor = createPluginContextFactory({
		controlServer,
		getWorkers: () => [],
		emitter: new EventEmitter(),
		stopProcess,
		restartProcess,
		startProcess,
	});
	await processesPlugin.register(contextFor("core:processes"));
	const { port } = await controlServer.listen();

	return {
		port,
		token: controlServer.token,
		stopProcess,
		restartProcess,
		startProcess,
		async post(path: string): Promise<{ status: number; text: string }> {
			const res = await fetch(`http://127.0.0.1:${port}${path}`, {
				method: "POST",
				headers: { Authorization: `Bearer ${controlServer.token}` },
			});
			return { status: res.status, text: await res.text() };
		},
		async cleanup() {
			await controlServer.close();
		},
	};
}

describe("core:processes plugin", () => {
	describe("POST /api/processes/stop", () => {
		it("400s when the name query param is missing", async () => {
			const h = await createHarness();
			const { status, text } = await h.post("/api/processes/stop");
			expect(status).toBe(400);
			expect(text).toBe("name query param required");
			expect(h.stopProcess).not.toHaveBeenCalled();
			await h.cleanup();
		});

		it("400s when the name query param is present but empty", async () => {
			const h = await createHarness();
			const { status } = await h.post("/api/processes/stop?name=");
			expect(status).toBe(400);
			await h.cleanup();
		});

		it('200s and calls ctx.stopProcess with the given name on "ok"', async () => {
			const h = await createHarness();
			const { status, text } = await h.post("/api/processes/stop?name=web");
			expect(status).toBe(200);
			expect(text).toBe("ok");
			expect(h.stopProcess).toHaveBeenCalledWith("web");
			await h.cleanup();
		});

		it('404s with a stop-specific message for "unknown"', async () => {
			const h = await createHarness({
				stopProcess: async () => "unknown",
			});
			const { status, text } = await h.post("/api/processes/stop?name=web");
			expect(status).toBe(404);
			expect(text).toBe("unknown process, or it isn't currently running");
			await h.cleanup();
		});

		it('409s for "busy"', async () => {
			const h = await createHarness({ stopProcess: async () => "busy" });
			const { status, text } = await h.post("/api/processes/stop?name=web");
			expect(status).toBe(409);
			expect(text).toBe(
				"busy: an operation is already in progress for this process",
			);
			await h.cleanup();
		});
	});

	describe("POST /api/processes/restart", () => {
		it("400s when the name query param is missing", async () => {
			const h = await createHarness();
			const { status } = await h.post("/api/processes/restart");
			expect(status).toBe(400);
			expect(h.restartProcess).not.toHaveBeenCalled();
			await h.cleanup();
		});

		it('200s and calls ctx.restartProcess with the given name on "ok"', async () => {
			const h = await createHarness();
			const { status } = await h.post("/api/processes/restart?name=web");
			expect(status).toBe(200);
			expect(h.restartProcess).toHaveBeenCalledWith("web");
			await h.cleanup();
		});

		it('404s with the generic message for "unknown"', async () => {
			const h = await createHarness({ restartProcess: async () => "unknown" });
			const { status, text } = await h.post("/api/processes/restart?name=web");
			expect(status).toBe(404);
			expect(text).toBe("unknown process");
			await h.cleanup();
		});

		it('409s for "busy"', async () => {
			const h = await createHarness({ restartProcess: async () => "busy" });
			const { status } = await h.post("/api/processes/restart?name=web");
			expect(status).toBe(409);
			await h.cleanup();
		});
	});

	describe("POST /api/processes/start", () => {
		it("400s when the name query param is missing", async () => {
			const h = await createHarness();
			const { status } = await h.post("/api/processes/start");
			expect(status).toBe(400);
			expect(h.startProcess).not.toHaveBeenCalled();
			await h.cleanup();
		});

		it('200s and calls ctx.startProcess with the given name on "ok"', async () => {
			const h = await createHarness();
			const { status } = await h.post("/api/processes/start?name=web");
			expect(status).toBe(200);
			expect(h.startProcess).toHaveBeenCalledWith("web");
			await h.cleanup();
		});

		it('404s with the generic message for "unknown"', async () => {
			const h = await createHarness({ startProcess: async () => "unknown" });
			const { status, text } = await h.post("/api/processes/start?name=web");
			expect(status).toBe(404);
			expect(text).toBe("unknown process");
			await h.cleanup();
		});
	});
});
