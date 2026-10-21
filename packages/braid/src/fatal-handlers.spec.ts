import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFatalHandlers } from "./fatal-handlers.js";

describe("installFatalHandlers", () => {
	let listeners: Map<string, (error: unknown) => void>;
	let stderr: string[];

	beforeEach(() => {
		vi.useFakeTimers();
		listeners = new Map();
		stderr = [];
		// Captured rather than really registered: emitting a synthetic uncaughtException/
		// unhandledRejection on the real process would reach the test runner's own handlers too.
		vi.spyOn(process, "on").mockImplementation(((
			event: string,
			listener: (error: unknown) => void,
		) => {
			listeners.set(event, listener);
			return process;
		}) as typeof process.on);
		vi.spyOn(process, "off").mockImplementation(((event: string) => {
			listeners.delete(event);
			return process;
		}) as typeof process.off);
		vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
			stderr.push(String(chunk));
			return true;
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("registers for both uncaught exceptions and unhandled rejections, and can remove them", () => {
		const remove = installFatalHandlers(new AbortController(), 1000, vi.fn());
		expect([...listeners.keys()].sort()).toEqual([
			"uncaughtException",
			"unhandledRejection",
		]);
		remove();
		expect(listeners.size).toBe(0);
	});

	it("logs the error, aborts the controller, and exits 1 only once the watchdog runs out", () => {
		const controller = new AbortController();
		const exit = vi.fn();
		installFatalHandlers(controller, 1000, exit);

		listeners.get("uncaughtException")?.(new Error("boom"));

		expect(stderr.join("")).toContain(
			"internal error, stopping all processes: Error: boom",
		);
		expect(controller.signal.aborted).toBe(true);
		vi.advanceTimersByTime(999);
		expect(exit).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(exit).toHaveBeenCalledWith(1);
	});

	it("only logs a second fatal error while already stopping, without arming a second watchdog", () => {
		const controller = new AbortController();
		const exit = vi.fn();
		installFatalHandlers(controller, 1000, exit);

		listeners.get("unhandledRejection")?.("first");
		listeners.get("unhandledRejection")?.("second");

		expect(stderr.join("")).toContain("stopping all processes: first");
		expect(stderr.join("")).toContain("stopping all processes: second");
		vi.advanceTimersByTime(1000);
		expect(exit).toHaveBeenCalledTimes(1);
	});

	it("formats an Error with no stack by its message", () => {
		installFatalHandlers(new AbortController(), 1000, vi.fn());
		const error = new Error("no stack");
		error.stack = undefined;
		listeners.get("uncaughtException")?.(error);
		expect(stderr.join("")).toContain("stopping all processes: no stack");
	});

	it("exits the real process by default", () => {
		const exitSpy = vi
			.spyOn(process, "exit")
			.mockImplementation(() => undefined as never);
		installFatalHandlers(new AbortController(), 10);
		listeners.get("uncaughtException")?.(new Error("boom"));
		vi.advanceTimersByTime(10);
		expect(exitSpy).toHaveBeenCalledWith(1);
	});
});
