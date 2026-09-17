import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlServer } from "./control-server.js";
import {
	createPluginContextFactory,
	registerPlugin,
	safeEmit,
} from "./plugin-runtime.js";
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
		startProcess: vi.fn(async (): Promise<ProcessActionResult> => "ok"),
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

	it("stringifies a non-Error value thrown by a listener instead of rendering [object Object]", async () => {
		const writeSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		const emitter = new EventEmitter();
		emitter.on("daemonShutdown", () => {
			throw "plain string boom";
		});

		await safeEmit(emitter, "daemonShutdown", { type: "daemonShutdown" });

		expect(
			writeSpy.mock.calls.some((call) =>
				String(call[0]).includes("plain string boom"),
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

	it("stringifies a non-Error value thrown by register() instead of rendering [object Object]", async () => {
		const ctx = stubContext();
		const plugin: BraidPlugin = {
			name: "p",
			register: () => {
				throw "plain string boom";
			},
		};
		await registerPlugin(plugin, ctx);
		expect(ctx.log).toHaveBeenCalledWith(
			expect.stringContaining("plain string boom"),
		);
	});
});

describe("createPluginContextFactory", () => {
	function buildOptions() {
		// Only registerRoute/registerStatic/registerUpgrade are ever read by
		// createPluginContextFactory - the rest just satisfy ControlServer's full shape.
		const controlServer: ControlServer = {
			registerRoute: vi.fn(),
			registerStatic: vi.fn(),
			registerUpgrade: vi.fn(),
			listen: vi.fn(async () => ({ port: 0 })),
			close: vi.fn(async () => {}),
			token: "test-token",
		};
		const emitter = new EventEmitter();
		const getWorkers = vi.fn(() => []);
		const stopProcess = vi.fn(
			async (): Promise<ProcessActionResult> => "ok" as const,
		);
		const restartProcess = vi.fn(
			async (): Promise<ProcessActionResult> => "ok" as const,
		);
		const startProcess = vi.fn(
			async (): Promise<ProcessActionResult> => "ok" as const,
		);
		return {
			controlServer,
			emitter,
			getWorkers,
			stopProcess,
			restartProcess,
			startProcess,
		};
	}

	it("delegates registerRoute/registerStatic/registerUpgrade straight to the control server", () => {
		const opts = buildOptions();
		const ctx = createPluginContextFactory(opts)("my-plugin");
		expect(ctx.registerRoute).toBe(opts.controlServer.registerRoute);
		expect(ctx.registerStatic).toBe(opts.controlServer.registerStatic);
		expect(ctx.registerUpgrade).toBe(opts.controlServer.registerUpgrade);
	});

	it("wires on() to the shared emitter", () => {
		const opts = buildOptions();
		const ctx = createPluginContextFactory(opts)("my-plugin");
		const handler = vi.fn();
		ctx.on("daemonShutdown", handler);
		opts.emitter.emit("daemonShutdown", { type: "daemonShutdown" });
		expect(handler).toHaveBeenCalledWith({ type: "daemonShutdown" });
	});

	it("delegates getProcesses/stopProcess/restartProcess/startProcess to the given functions", async () => {
		const opts = buildOptions();
		const ctx = createPluginContextFactory(opts)("my-plugin");
		expect(ctx.getProcesses).toBe(opts.getWorkers);
		await expect(ctx.stopProcess("web")).resolves.toBe("ok");
		expect(opts.stopProcess).toHaveBeenCalledWith("web");
		await expect(ctx.restartProcess("web")).resolves.toBe("ok");
		expect(opts.restartProcess).toHaveBeenCalledWith("web");
		await expect(ctx.startProcess("web")).resolves.toBe("ok");
		expect(opts.startProcess).toHaveBeenCalledWith("web");
	});

	describe("log", () => {
		let originalSend: typeof process.send;
		let originalConnected: boolean | undefined;

		afterEach(() => {
			process.send = originalSend;
			process.connected = originalConnected as boolean;
			vi.restoreAllMocks();
		});

		it("always writes the message to stderr, prefixed with the plugin's own tag", () => {
			originalSend = process.send;
			originalConnected = process.connected;
			const writeSpy = vi
				.spyOn(process.stderr, "write")
				.mockImplementation(() => true);
			const ctx = createPluginContextFactory(buildOptions())("my-plugin");

			ctx.log("hello");

			expect(writeSpy).toHaveBeenCalledTimes(1);
			const [line] = writeSpy.mock.calls[0];
			expect(String(line)).toContain("my-plugin");
			expect(String(line)).toContain("hello");
		});

		it("relays the line over IPC when connected and process.send is available", () => {
			originalSend = process.send;
			originalConnected = process.connected;
			vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			process.connected = true;
			const sendSpy = vi.fn();
			process.send = sendSpy as unknown as typeof process.send;
			const ctx = createPluginContextFactory(buildOptions())("my-plugin");

			ctx.log("hello");

			expect(sendSpy).toHaveBeenCalledTimes(1);
			const [message] = sendSpy.mock.calls[0] as [
				{ type: string; message: string },
			];
			expect(message.type).toBe("log");
			expect(message.message).toContain("hello");
		});

		it("does not attempt IPC when not connected, even if process.send exists", () => {
			originalSend = process.send;
			originalConnected = process.connected;
			vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			process.connected = false;
			const sendSpy = vi.fn();
			process.send = sendSpy as unknown as typeof process.send;
			const ctx = createPluginContextFactory(buildOptions())("my-plugin");

			ctx.log("hello");

			expect(sendSpy).not.toHaveBeenCalled();
		});

		it("does not throw when connected but process.send is undefined (e.g. running in the foreground/tests)", () => {
			originalSend = process.send;
			originalConnected = process.connected;
			vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			process.connected = true;
			process.send = undefined;
			const ctx = createPluginContextFactory(buildOptions())("my-plugin");

			expect(() => ctx.log("hello")).not.toThrow();
		});
	});
});
