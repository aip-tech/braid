import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { registerPlugin, safeEmit } from "./plugin-runtime.js";
import type {
	BraidPlugin,
	PluginContext,
	ProcessActionResult,
} from "./types.js";

function stubContext(): PluginContext {
	return {
		registerRoute: vi.fn(),
		registerStatic: vi.fn(),
		registerUpgrade: vi.fn(),
		on: vi.fn(),
		getProcesses: vi.fn(() => []),
		stopProcess: vi.fn(async (): Promise<ProcessActionResult> => "ok"),
		restartProcess: vi.fn(async (): Promise<ProcessActionResult> => "ok"),
		log: vi.fn(),
	};
}

describe("safeEmit", () => {
	it("isolates a synchronously throwing listener from the others", async () => {
		const writeSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		const emitter = new EventEmitter();
		const calls: string[] = [];
		emitter.on("daemonShutdown", () => {
			throw new Error("boom");
		});
		emitter.on("daemonShutdown", () => {
			calls.push("second");
		});

		await expect(
			safeEmit(emitter, "daemonShutdown", { type: "daemonShutdown" }),
		).resolves.toBeUndefined();

		expect(calls).toEqual(["second"]);
		expect(
			writeSpy.mock.calls.some((call) => String(call[0]).includes("boom")),
		).toBe(true);
		writeSpy.mockRestore();
	});

	it("isolates an async listener whose promise rejects from the others", async () => {
		const writeSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		const emitter = new EventEmitter();
		const calls: string[] = [];
		emitter.on("daemonShutdown", async () => {
			await Promise.resolve();
			throw new Error("async boom");
		});
		emitter.on("daemonShutdown", () => {
			calls.push("second");
		});

		await expect(
			safeEmit(emitter, "daemonShutdown", { type: "daemonShutdown" }),
		).resolves.toBeUndefined();

		expect(calls).toEqual(["second"]);
		expect(
			writeSpy.mock.calls.some((call) =>
				String(call[0]).includes("async boom"),
			),
		).toBe(true);
		writeSpy.mockRestore();
	});
});

describe("registerPlugin", () => {
	it("calls register() with the given context and options", async () => {
		const ctx = stubContext();
		const plugin: BraidPlugin = { name: "p", register: vi.fn() };
		await registerPlugin(plugin, ctx, { foo: "bar" });
		expect(plugin.register).toHaveBeenCalledWith(ctx, { foo: "bar" });
	});

	it("isolates a synchronous throw from register()", async () => {
		const ctx = stubContext();
		const plugin: BraidPlugin = {
			name: "p",
			register: () => {
				throw new Error("sync boom");
			},
		};
		await expect(registerPlugin(plugin, ctx)).resolves.toBeUndefined();
		expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining("sync boom"));
	});

	it("isolates a rejected promise from an async register()", async () => {
		const ctx = stubContext();
		const plugin: BraidPlugin = {
			name: "p",
			register: async () => {
				throw new Error("async boom");
			},
		};
		await expect(registerPlugin(plugin, ctx)).resolves.toBeUndefined();
		expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining("async boom"));
	});

	it("does not log anything when register() succeeds", async () => {
		const ctx = stubContext();
		const plugin: BraidPlugin = { name: "p", register: vi.fn() };
		await registerPlugin(plugin, ctx);
		expect(ctx.log).not.toHaveBeenCalled();
	});
});
