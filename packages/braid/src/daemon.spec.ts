import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { braidTag } from "./prefix.js";
import type { ProcessConfig } from "./types.js";

const runManagerMock = vi.fn();
vi.mock("./manager.js", () => ({
	runManager: (...args: unknown[]) => runManagerMock(...args),
}));

// daemon.ts runs `main()` for real, at module load, if BRAID_DAEMON_INPUT happens to already be
// set when it's imported (see its own bottom-of-file guard) - unset it first so importing the
// module here (to unit-test its exported pieces directly) can't accidentally trigger that.
delete process.env.BRAID_DAEMON_INPUT;
const { loadInput, main, reportStartupFailure, send } = await import(
	"./daemon.js"
);

const PROCESSES: ProcessConfig[] = [{ name: "web", command: "node" }];

describe("daemon.ts", () => {
	const originalInput = process.env.BRAID_DAEMON_INPUT;
	const originalSend = process.send;

	beforeEach(() => {
		runManagerMock.mockReset();
	});

	afterEach(() => {
		if (originalInput === undefined) {
			process.env.BRAID_DAEMON_INPUT = undefined;
			delete process.env.BRAID_DAEMON_INPUT;
		} else {
			process.env.BRAID_DAEMON_INPUT = originalInput;
		}
		process.send = originalSend;
		vi.restoreAllMocks();
	});

	describe("loadInput", () => {
		it("throws a clear error when BRAID_DAEMON_INPUT is unset", () => {
			delete process.env.BRAID_DAEMON_INPUT;
			expect(() => loadInput()).toThrow(
				"braid daemon started without BRAID_DAEMON_INPUT",
			);
		});

		it("throws the same error for an empty string, not just a missing var", () => {
			process.env.BRAID_DAEMON_INPUT = "";
			expect(() => loadInput()).toThrow(
				"braid daemon started without BRAID_DAEMON_INPUT",
			);
		});

		it("parses the JSON payload into the daemon's input shape", () => {
			const input = {
				processes: PROCESSES,
				plugins: [["@aip-tech/braid-plugin-ui", { path: "/ui" }]],
				configPath: "/project/braid.config.ts",
				logs: { dir: "/project/.braid/logs", maxSizeBytes: 1024 },
				pidfilePath: "/project/.braid/run.json",
				statsPollIntervalMs: 500,
			};
			process.env.BRAID_DAEMON_INPUT = JSON.stringify(input);
			expect(loadInput()).toEqual(input);
		});
	});

	describe("send", () => {
		it("forwards the message to process.send when connected", () => {
			const sendSpy = vi.fn(() => true);
			process.send = sendSpy as unknown as typeof process.send;
			send({ type: "ready" });
			expect(sendSpy).toHaveBeenCalledWith({ type: "ready" });
		});

		it("does nothing (does not throw) when process.send is undefined", () => {
			process.send = undefined;
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
			process.env.BRAID_DAEMON_INPUT = JSON.stringify(input);
			runManagerMock.mockResolvedValue(7);
			const exitSpy = vi
				.spyOn(process, "exit")
				.mockImplementation(() => undefined as never);
			const sendSpy = vi.fn(() => true);
			process.send = sendSpy as unknown as typeof process.send;

			await main();

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

			// The exit code passed to process.exit() must be exactly what runManager resolved with,
			// not a hardcoded 0 - this is what lets a crashed stack (see manager.ts's `shutdown`)
			// propagate a non-zero exit code all the way out to whatever launched `braid start`.
			expect(exitSpy).toHaveBeenCalledWith(7);

			// runManager's onReady option is the one piece of behavior main() itself wires up (not
			// just plumbing through the parsed input) - calling it must send the "ready" handshake.
			expect(sendSpy).not.toHaveBeenCalled();
			options.onReady();
			expect(sendSpy).toHaveBeenCalledWith({ type: "ready" });
		});

		it("passes undefined for every optional field a minimal input omits", async () => {
			const input = { processes: PROCESSES, pidfilePath: "/x/run.json" };
			process.env.BRAID_DAEMON_INPUT = JSON.stringify(input);
			runManagerMock.mockResolvedValue(0);
			vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

			await main();

			const [, , options] = runManagerMock.mock.calls[0];
			expect(options.plugins).toBeUndefined();
			expect(options.configPath).toBeUndefined();
			expect(options.logs).toBeUndefined();
			expect(options.statsPollIntervalMs).toBeUndefined();
		});

		it("rejects without calling runManager when the input itself is missing", async () => {
			delete process.env.BRAID_DAEMON_INPUT;
			await expect(main()).rejects.toThrow("BRAID_DAEMON_INPUT");
			expect(runManagerMock).not.toHaveBeenCalled();
		});

		it("propagates a runManager rejection instead of exiting", async () => {
			process.env.BRAID_DAEMON_INPUT = JSON.stringify({
				processes: PROCESSES,
				pidfilePath: "/x/run.json",
			});
			runManagerMock.mockRejectedValueOnce(new Error("already running"));
			const exitSpy = vi
				.spyOn(process, "exit")
				.mockImplementation(() => undefined as never);

			await expect(main()).rejects.toThrow("already running");
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
			expect(sendSpy).toHaveBeenCalledWith({
				type: "error",
				message: "config is bad",
			});
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
			expect(sendSpy).toHaveBeenCalledWith({
				type: "error",
				message: "just a string",
			});
		});

		it("still reports (without throwing) when process.send is undefined", () => {
			vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			process.send = undefined;
			expect(() => reportStartupFailure(new Error("boom"))).not.toThrow();
		});
	});
});
