import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { braidTag } from "./prefix.js";
import type { ProcessConfig } from "./types.js";

const runManagerMock = vi.fn();
vi.mock("./manager.js", () => ({
	runManager: (...args: unknown[]) => runManagerMock(...args),
	shutdownBudgetMs: () => 9000,
}));
// main() installs process-wide fatal handlers - real ones would outlive each test inside the test
// runner's own process (and could even exit it via their watchdog), so they're stubbed here.
// fatal-handlers.spec.ts covers them directly.
const installFatalHandlersMock = vi.fn(() => () => {});
vi.mock("./fatal-handlers.js", () => ({
	installFatalHandlers: (...args: unknown[]) =>
		installFatalHandlersMock(...(args as [])),
}));

// daemon.ts runs `main()` for real, at module load, if BRAID_DAEMON=1 happens to already be set
// when it's imported (see its own bottom-of-file guard) - unset it first so importing the module
// here (to unit-test its exported pieces directly) can't accidentally trigger that.
delete process.env.BRAID_DAEMON;
const { INPUT_TIMEOUT_MS, main, receiveInput, reportStartupFailure, send } =
	await import("./daemon.js");

/** Stands in for the daemon's IPC channel - in a test, the real one belongs to the test runner. */
function fakeChannel() {
	const channel = new EventEmitter();
	return Object.assign(channel, {
		deliver(input: unknown) {
			channel.emit("message", { type: "braid-daemon-input", input });
		},
	});
}

const PROCESSES: ProcessConfig[] = [{ name: "web", command: "node" }];

describe("daemon.ts", () => {
	const originalSend = process.send;

	const originalConnected = process.connected;

	beforeEach(() => {
		runManagerMock.mockReset();
		installFatalHandlersMock.mockClear();
		// `send` only attempts IPC while connected - pin it, rather than depending on whether the
		// test runner's own worker happens to be IPC-connected.
		process.connected = true;
	});

	afterEach(() => {
		process.send = originalSend;
		process.connected = originalConnected;
		vi.restoreAllMocks();
	});

	describe("receiveInput", () => {
		it("resolves with the input from the CLI's input message, ignoring anything else on the channel", async () => {
			const channel = fakeChannel();
			const received = receiveInput(channel);
			const input = { processes: PROCESSES, pidfilePath: "/x/run.json" };
			// Other traffic first - e.g. the test runner's own RPC over a shared channel.
			channel.emit("message", { type: "something-else", input: "not this" });
			channel.emit("message", "a bare string");
			channel.emit("message", null);
			channel.deliver(input);
			await expect(received).resolves.toEqual(input);
			expect(channel.listenerCount("message")).toBe(0);
		});

		it("gives up with a clear error if no input arrives in time", async () => {
			vi.useFakeTimers();
			try {
				const channel = fakeChannel();
				const received = receiveInput(channel, 1000);
				const assertion = expect(received).rejects.toThrow(
					"braid daemon didn't receive its config from the CLI within 1000ms",
				);
				await vi.advanceTimersByTimeAsync(1000);
				await assertion;
				expect(channel.listenerCount("message")).toBe(0);
			} finally {
				vi.useRealTimers();
			}
		});

		it("listens on the real process channel by default, with the default timeout", async () => {
			vi.useFakeTimers();
			try {
				const on = vi.spyOn(process, "on");
				const received = receiveInput();
				expect(on).toHaveBeenCalledWith("message", expect.any(Function));
				const assertion = expect(received).rejects.toThrow(
					`within ${INPUT_TIMEOUT_MS}ms`,
				);
				await vi.advanceTimersByTimeAsync(INPUT_TIMEOUT_MS);
				await assertion;
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe("send", () => {
		it("forwards the message to process.send when connected", () => {
			process.connected = true;
			const sendSpy = vi.fn(() => true);
			process.send = sendSpy as unknown as typeof process.send;
			send({ type: "ready" });
			expect(sendSpy).toHaveBeenCalledWith(
				{ type: "ready" },
				expect.any(Function),
			);
		});

		it("does nothing (does not throw) when process.send is undefined", () => {
			process.connected = true;
			process.send = undefined;
			expect(() => send({ type: "ready" })).not.toThrow();
		});

		it("does not attempt a send once the CLI has disconnected (e.g. after its startup timeout)", () => {
			process.connected = false;
			const sendSpy = vi.fn(() => true);
			process.send = sendSpy as unknown as typeof process.send;
			send({ type: "ready" });
			expect(sendSpy).not.toHaveBeenCalled();
		});

		it("absorbs a send that loses the race with a disconnect instead of throwing", () => {
			process.connected = true;
			const sendSpy = vi.fn(
				(_message: unknown, callback?: (e: Error) => void) => {
					callback?.(new Error("ERR_IPC_CHANNEL_CLOSED"));
					return false;
				},
			);
			process.send = sendSpy as unknown as typeof process.send;
			expect(() => send({ type: "ready" })).not.toThrow();
		});
	});

	describe("main", () => {
		it("runs the manager with the parsed input, and exits with its resulting code", async () => {
			const input = {
				processes: PROCESSES,
				plugins: [["@aip-tech/braid-plugin-ui", { path: "/ui" }]],
				configPath: "/project/braid.config.ts",
				logs: { dir: "/project/.braid/logs" },
				pidfilePath: "/project/.braid/run.json",
				statsPollIntervalMs: 500,
			};
			const channel = fakeChannel();
			runManagerMock.mockResolvedValue(7);
			const exitSpy = vi
				.spyOn(process, "exit")
				.mockImplementation(() => undefined as never);
			const sendSpy = vi.fn(() => true);
			process.send = sendSpy as unknown as typeof process.send;

			const running = main(channel);
			channel.deliver(input);
			await running;

			expect(runManagerMock).toHaveBeenCalledTimes(1);
			const [processes, pidfilePath, options] = runManagerMock.mock.calls[0];
			expect(processes).toEqual(input.processes);
			expect(pidfilePath).toBe(input.pidfilePath);
			expect(options).toMatchObject({
				plugins: input.plugins,
				configPath: input.configPath,
				logs: input.logs,
				statsPollIntervalMs: input.statsPollIntervalMs,
			});

			// The fatal-error handlers abort exactly the signal runManager was given, with a watchdog
			// sized from the stack's own shutdown budget (stubbed to 9000 above) plus margin.
			expect(installFatalHandlersMock).toHaveBeenCalledTimes(1);
			const [controller, watchdogMs] = installFatalHandlersMock.mock
				.calls[0] as unknown as [AbortController, number];
			expect(watchdogMs).toBe(14_000);
			expect(options.signal).toBe(controller.signal);

			// The exit code passed to process.exit() must be exactly what runManager resolved with,
			// not a hardcoded 0 - this is what lets a crashed stack (see manager.ts's `shutdown`)
			// propagate a non-zero exit code all the way out to whatever launched `braid start`.
			expect(exitSpy).toHaveBeenCalledWith(7);

			// runManager's onReady option is the one piece of behavior main() itself wires up (not
			// just plumbing through the parsed input) - calling it must send the "ready" handshake.
			expect(sendSpy).not.toHaveBeenCalled();
			options.onReady();
			expect(sendSpy).toHaveBeenCalledWith(
				{ type: "ready" },
				expect.any(Function),
			);
		});

		it("passes undefined for every optional field a minimal input omits", async () => {
			const input = { processes: PROCESSES, pidfilePath: "/x/run.json" };
			const channel = fakeChannel();
			runManagerMock.mockResolvedValue(0);
			vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

			const running = main(channel);
			channel.deliver(input);
			await running;

			const [, , options] = runManagerMock.mock.calls[0];
			expect(options.plugins).toBeUndefined();
			expect(options.configPath).toBeUndefined();
			expect(options.logs).toBeUndefined();
			expect(options.statsPollIntervalMs).toBeUndefined();
		});

		it("rejects without calling runManager when the input never arrives", async () => {
			vi.useFakeTimers();
			try {
				const running = main(fakeChannel());
				const assertion = expect(running).rejects.toThrow(
					"didn't receive its config",
				);
				await vi.advanceTimersByTimeAsync(INPUT_TIMEOUT_MS);
				await assertion;
				expect(runManagerMock).not.toHaveBeenCalled();
			} finally {
				vi.useRealTimers();
			}
		});

		it("waits on the real process channel by default", async () => {
			vi.useFakeTimers();
			try {
				const on = vi.spyOn(process, "on");
				const running = main();
				expect(on).toHaveBeenCalledWith("message", expect.any(Function));
				const assertion = expect(running).rejects.toThrow();
				await vi.advanceTimersByTimeAsync(INPUT_TIMEOUT_MS);
				await assertion;
			} finally {
				vi.useRealTimers();
			}
		});

		it("propagates a runManager rejection instead of exiting", async () => {
			runManagerMock.mockRejectedValueOnce(new Error("already running"));
			const exitSpy = vi
				.spyOn(process, "exit")
				.mockImplementation(() => undefined as never);
			const channel = fakeChannel();

			const running = main(channel);
			channel.deliver({ processes: PROCESSES, pidfilePath: "/x/run.json" });
			await expect(running).rejects.toThrow("already running");
			expect(exitSpy).not.toHaveBeenCalled();
		});
	});

	describe("reportStartupFailure", () => {
		it("logs an Error's message with the braid tag and sends an error handshake", () => {
			const writeSpy = vi
				.spyOn(process.stderr, "write")
				.mockImplementation(() => true);
			const sendSpy = vi.fn(() => true);
			process.send = sendSpy as unknown as typeof process.send;

			reportStartupFailure(new Error("config is bad"));

			expect(writeSpy).toHaveBeenCalledWith(
				`${braidTag()} daemon failed to start: config is bad\n`,
			);
			expect(sendSpy).toHaveBeenCalledWith(
				{ type: "error", message: "config is bad" },
				expect.any(Function),
			);
		});

		it("stringifies a non-Error thrown value instead of rendering it as [object Object]", () => {
			const writeSpy = vi
				.spyOn(process.stderr, "write")
				.mockImplementation(() => true);
			const sendSpy = vi.fn(() => true);
			process.send = sendSpy as unknown as typeof process.send;

			reportStartupFailure("just a string");

			expect(writeSpy).toHaveBeenCalledWith(
				`${braidTag()} daemon failed to start: just a string\n`,
			);
			expect(sendSpy).toHaveBeenCalledWith(
				{ type: "error", message: "just a string" },
				expect.any(Function),
			);
		});

		it("still reports (without throwing) when process.send is undefined", () => {
			vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			process.send = undefined;
			expect(() => reportStartupFailure(new Error("boom"))).not.toThrow();
		});
	});
});
