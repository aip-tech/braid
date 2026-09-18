import { EventEmitter } from "node:events";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BraidConfig, DaemonHandshakeMessage } from "./types.js";

// `startDaemon`'s ready/error/exit/fork-error/timeout race is a set of rare-failure-mode and
// timing paths a real forked daemon.ts can't be driven into deterministically from a test (see
// cli.spec.ts's own real-subprocess tests for the paths that *can* be exercised that way - a
// successful start, and a daemon that fails after actually running its own startup code). Mocking
// `fork` here lets each outcome be triggered directly and cheaply instead; everything else (the
// pidfile directory, daemon.log itself) is real filesystem I/O, unmocked.
vi.mock("node:child_process", () => ({ fork: vi.fn() }));

import { fork } from "node:child_process";
import { startDaemon } from "./cli.js";

type FakeChild = EventEmitter & {
	pid: number;
	disconnect: () => void;
	unref: () => void;
};

function makeFakeChild(pid: number): FakeChild {
	return Object.assign(new EventEmitter(), {
		pid,
		disconnect: vi.fn(),
		unref: vi.fn(),
	});
}

const CONFIG: BraidConfig = { processes: [{ name: "web", command: "node" }] };

describe("startDaemon", () => {
	let tmpDir: string;
	let pidfilePath: string;
	let configPath: string;
	let child: FakeChild;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "braid-start-daemon-"));
		pidfilePath = join(tmpDir, ".braid", "run.json");
		configPath = join(tmpDir, "braid.config.ts");
		child = makeFakeChild(4242);
		vi.mocked(fork).mockReturnValue(
			child as unknown as ReturnType<typeof fork>,
		);
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	function send(message: DaemonHandshakeMessage): void {
		child.emit("message", message);
	}

	it("resolves ok with the child's pid on a ready handshake, and disconnects + unrefs it", async () => {
		const promise = startDaemon(CONFIG, configPath, pidfilePath, tmpDir);
		send({ type: "ready" });
		await expect(promise).resolves.toEqual({
			ok: true,
			pid: 4242,
			logLines: [],
		});
		expect(child.disconnect).toHaveBeenCalledTimes(1);
		expect(child.unref).toHaveBeenCalledTimes(1);
	});

	it("buffers a 'log' handshake message instead of printing it immediately, without settling the race", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const promise = startDaemon(CONFIG, configPath, pidfilePath, tmpDir);
		send({ type: "log", message: "hello from a plugin" });
		// Buffered, not printed as it arrives - the caller (cli.ts's runStartCommand) flushes
		// `logLines` itself, only after it has printed the startup summary table.
		expect(logSpy).not.toHaveBeenCalled();
		send({ type: "ready" });
		await expect(promise).resolves.toEqual({
			ok: true,
			pid: 4242,
			logLines: ["hello from a plugin"],
		});
		logSpy.mockRestore();
	});

	it("resolves not-ok with the daemon's own message on an 'error' handshake message, without unref", async () => {
		const promise = startDaemon(CONFIG, configPath, pidfilePath, tmpDir);
		send({ type: "error", message: "config is broken" });
		await expect(promise).resolves.toEqual({
			ok: false,
			message: "config is broken",
		});
		expect(child.disconnect).toHaveBeenCalledTimes(1);
		expect(child.unref).not.toHaveBeenCalled();
	});

	it("resolves not-ok when the daemon process exits before ever sending a handshake message", async () => {
		const promise = startDaemon(CONFIG, configPath, pidfilePath, tmpDir);
		child.emit("exit", 7);
		const outcome = await promise;
		expect(outcome.ok).toBe(false);
		expect(!outcome.ok && outcome.message).toContain(
			"daemon exited before starting up (code 7)",
		);
	});

	it("resolves not-ok when fork() itself reports an error", async () => {
		const promise = startDaemon(CONFIG, configPath, pidfilePath, tmpDir);
		child.emit("error", new Error("EMFILE"));
		const outcome = await promise;
		expect(outcome.ok).toBe(false);
		expect(!outcome.ok && outcome.message).toBe(
			"failed to start daemon: EMFILE",
		);
	});

	it("times out with a clear message if the daemon never confirms startup", async () => {
		vi.useFakeTimers();
		try {
			const promise = startDaemon(CONFIG, configPath, pidfilePath, tmpDir);
			await vi.advanceTimersByTimeAsync(5000);
			const outcome = await promise;
			expect(outcome.ok).toBe(false);
			expect(!outcome.ok && outcome.message).toContain(
				"did not confirm startup within 5000ms",
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("rotates an existing daemon.log left over from a previous run instead of appending to it", async () => {
		mkdirSync(dirname(pidfilePath), { recursive: true, mode: 0o700 });
		const daemonLogPath = join(tmpDir, ".braid", "daemon.log");
		writeFileSync(daemonLogPath, "leftover from last run\n");

		const promise = startDaemon(CONFIG, configPath, pidfilePath, tmpDir);
		send({ type: "ready" });
		await promise;

		expect(readFileSync(`${daemonLogPath}.1`, "utf8")).toBe(
			"leftover from last run\n",
		);
	});

	it("prints nothing extra on failure when daemon.log is empty (no useful tail to show)", async () => {
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		const promise = startDaemon(CONFIG, configPath, pidfilePath, tmpDir);
		send({ type: "error", message: "boom" });
		await promise;
		expect(errorSpy).not.toHaveBeenCalled();
		errorSpy.mockRestore();
	});

	it("does not propagate an error from child.disconnect() itself failing on the failure path", async () => {
		child.disconnect = vi.fn(() => {
			throw new Error("IPC channel is already disconnected");
		});
		const promise = startDaemon(CONFIG, configPath, pidfilePath, tmpDir);
		send({ type: "error", message: "boom" });
		await expect(promise).resolves.toEqual({ ok: false, message: "boom" });
	});
});
