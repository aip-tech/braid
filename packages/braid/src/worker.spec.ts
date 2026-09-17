import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { colorize } from "./prefix.js";
import type { ProcessConfig } from "./types.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("tree-kill", () => ({ default: vi.fn() }));
vi.mock("chokidar", () => ({ watch: vi.fn() }));

import { spawn } from "node:child_process";
import { watch as watchFiles } from "chokidar";
import treeKill from "tree-kill";
import { loadConfig, RESTART_DEBOUNCE_MS, runWorker } from "./worker.js";

type FakeChild = EventEmitter & {
	pid: number;
	stdout: EventEmitter;
	stderr: EventEmitter;
};

function makeFakeChild(pid: number): FakeChild {
	return Object.assign(new EventEmitter(), {
		pid,
		stdout: new EventEmitter(),
		stderr: new EventEmitter(),
	});
}

type SpawnCall = {
	command: string;
	args: string[];
	options: Record<string, unknown>;
	child: FakeChild;
};

describe("loadConfig", () => {
	const original = process.env.BRAID_CONFIG;
	afterEach(() => {
		if (original === undefined) delete process.env.BRAID_CONFIG;
		else process.env.BRAID_CONFIG = original;
	});

	it("throws a clear error when BRAID_CONFIG is unset", () => {
		delete process.env.BRAID_CONFIG;
		expect(() => loadConfig()).toThrow(
			"braid worker started without BRAID_CONFIG",
		);
	});

	it("parses the JSON payload into a ProcessConfig", () => {
		const config: ProcessConfig = { name: "web", command: "node" };
		process.env.BRAID_CONFIG = JSON.stringify(config);
		expect(loadConfig()).toEqual(config);
	});
});

describe("runWorker", () => {
	let nextPid: number;
	let spawnCalls: SpawnCall[];
	let treeKillCalls: Array<{ pid: number; signal: string }>;
	let watcher: EventEmitter;
	let stdoutWrites: string[];
	let stderrWrites: string[];
	let sentMessages: unknown[];
	let exitCalls: Array<number | undefined>;
	let originalSend: typeof process.send;

	function lastChild(): FakeChild {
		const call = spawnCalls.at(-1);
		if (!call) throw new Error("expected spawn to have been called by now");
		return call.child;
	}

	beforeEach(() => {
		vi.useFakeTimers();
		nextPid = 1000;
		spawnCalls = [];
		treeKillCalls = [];
		watcher = new EventEmitter();
		stdoutWrites = [];
		stderrWrites = [];
		sentMessages = [];
		exitCalls = [];
		originalSend = process.send;
		delete process.env.BRAID_LOG_TIMESTAMPS;
		// mockImplementation() below only sets what a mock *does* - it doesn't reset .mock.calls, so
		// without this, e.g. vi.mocked(watchFiles).mock.calls[0] would keep pointing at the very
		// first test's call, not this test's own.
		vi.clearAllMocks();

		vi.mocked(spawn).mockImplementation(((
			command: string,
			args?: readonly string[],
			options?: Record<string, unknown>,
		) => {
			const child = makeFakeChild(nextPid++);
			spawnCalls.push({
				command,
				args: [...(args ?? [])],
				options: options ?? {},
				child,
			});
			return child as unknown as ChildProcess;
		}) as unknown as typeof spawn);

		vi.mocked(treeKill).mockImplementation(((
			pid: number,
			signal: string,
			callback?: () => void,
		) => {
			treeKillCalls.push({ pid, signal });
			callback?.();
		}) as unknown as typeof treeKill);

		vi.mocked(watchFiles).mockImplementation(
			(() => watcher) as unknown as typeof watchFiles,
		);

		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			stdoutWrites.push(chunk.toString());
			return true;
		});
		vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
			stderrWrites.push(chunk.toString());
			return true;
		});
		process.send = ((message: unknown, callback?: () => void) => {
			sentMessages.push(message);
			callback?.();
			return true;
		}) as unknown as typeof process.send;
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			exitCalls.push(code);
			return undefined as never;
		}) as unknown as typeof process.exit);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		process.send = originalSend;
	});

	describe("a non-watched process", () => {
		it("spawns the configured command with its args and env merged over process.env", () => {
			runWorker({
				name: "web",
				command: "node",
				args: ["server.js"],
				env: { PORT: "3000" },
			});
			expect(spawnCalls).toHaveLength(1);
			expect(spawnCalls[0].command).toBe("node");
			expect(spawnCalls[0].args).toEqual(["server.js"]);
			expect(spawnCalls[0].options.env).toMatchObject({
				...process.env,
				PORT: "3000",
			});
			expect(watchFiles).not.toHaveBeenCalled();
		});

		it("prefixes and forwards the child's stdout/stderr to this process's own streams", () => {
			runWorker({ name: "web", command: "node" });
			const child = lastChild();
			child.stdout.emit("data", Buffer.from("hello\n"));
			child.stderr.emit("data", Buffer.from("oops\n"));
			expect(stdoutWrites.join("")).toBe(
				`${colorize("[web]", undefined)} hello\n`,
			);
			expect(stderrWrites.join("")).toBe(
				`${colorize("[web]", undefined)} oops\n`,
			);
		});

		it("uses the configured color for the line prefix", () => {
			runWorker({ name: "web", command: "node", color: "blue" });
			lastChild().stdout.emit("data", Buffer.from("hi\n"));
			expect(stdoutWrites.join("")).toBe(`${colorize("[web]", "blue")} hi\n`);
		});

		it("prepends a timestamp to every line when BRAID_LOG_TIMESTAMPS=1", () => {
			process.env.BRAID_LOG_TIMESTAMPS = "1";
			runWorker({ name: "web", command: "node" });
			lastChild().stdout.emit("data", Buffer.from("hello\n"));
			// A colon/dot-separated HH:MM:SS.mmm clock reading, gray-colored (linePrefixer's own
			// job, already unit-tested in prefix.spec.ts) and ahead of the usual "[web] " prefix.
			expect(stdoutWrites[0]).toMatch(/\d{2}:\d{2}:\d{2}\.\d{3}/);
			expect(stdoutWrites[0]).toContain(
				`${colorize("[web]", undefined)} hello\n`,
			);
		});

		it("does not prepend a timestamp when BRAID_LOG_TIMESTAMPS is unset", () => {
			runWorker({ name: "web", command: "node" });
			lastChild().stdout.emit("data", Buffer.from("hello\n"));
			expect(stdoutWrites[0]).toBe(`${colorize("[web]", undefined)} hello\n`);
		});

		it("flushes a trailing partial (no-newline) line to each stream on exit", () => {
			runWorker({ name: "web", command: "node" });
			const child = lastChild();
			child.stdout.emit("data", Buffer.from("partial-no-newline"));
			expect(stdoutWrites).toEqual([]); // buffered - no newline yet, nothing written
			child.emit("exit", 0);
			expect(stdoutWrites.join("")).toBe(
				`${colorize("[web]", undefined)} partial-no-newline\n`,
			);
		});

		it("exits the whole worker process with code 0 on a clean exit, without reporting a crash", () => {
			runWorker({ name: "web", command: "node" });
			lastChild().emit("exit", 0);
			expect(exitCalls).toEqual([0]);
			expect(sentMessages).toEqual([]);
		});

		it("sends a crash message then exits with the child's own code on a nonzero exit", () => {
			runWorker({ name: "web", command: "node" });
			lastChild().emit("exit", 3);
			expect(sentMessages).toEqual([
				{ source: "braid-worker", type: "crash", code: 3 },
			]);
			expect(exitCalls).toEqual([3]);
		});

		it("falls back to exit code 1 when the child died by signal (a null exit code)", () => {
			runWorker({ name: "web", command: "node" });
			lastChild().emit("exit", null);
			expect(sentMessages).toEqual([
				{ source: "braid-worker", type: "crash", code: null },
			]);
			expect(exitCalls).toEqual([1]);
		});

		it("still exits on crash when process.send is undefined (not IPC-connected, e.g. run directly)", () => {
			process.send = undefined;
			runWorker({ name: "web", command: "node" });
			lastChild().emit("exit", 3);
			expect(exitCalls).toEqual([3]);
		});

		it("treats an empty watch array the same as no watch at all", () => {
			runWorker({ name: "web", command: "node", watch: [] });
			expect(watchFiles).not.toHaveBeenCalled();
			lastChild().emit("exit", 0);
			expect(exitCalls).toEqual([0]); // exits, same as any other non-watched config
		});
	});

	describe("a watched process", () => {
		it("resolves relative watch paths against process.cwd() but passes an absolute one through unchanged", () => {
			runWorker({
				name: "web",
				command: "node",
				watch: ["/project/src", "relative/dir"],
			});
			expect(watchFiles).toHaveBeenCalledTimes(1);
			const [paths] = vi.mocked(watchFiles).mock.calls[0];
			expect(paths).toEqual([
				"/project/src",
				resolve(process.cwd(), "relative/dir"),
			]);
		});

		it("passes chokidar the default ignore list, ignoreInitial, and awaitWriteFinish options", () => {
			runWorker({ name: "web", command: "node", watch: ["/project/src"] });
			const [, options] = vi.mocked(watchFiles).mock.calls[0];
			expect(options).toMatchObject({
				ignoreInitial: true,
				awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 50 },
			});
			expect(options?.ignored).toEqual([
				"**/.git/**",
				"**/.nyc_output/**",
				"**/.sass-cache/**",
				"**/bower_components/**",
				"**/coverage/**",
				"**/node_modules/**",
			]);
		});

		it("adds each exclude entry and its whole subtree to the ignored list, resolved like watch paths", () => {
			runWorker({
				name: "web",
				command: "node",
				watch: ["/project/src"],
				exclude: ["/project/src/generated", "relative/skip"],
			});
			const [, options] = vi.mocked(watchFiles).mock.calls[0];
			const relativeSkip = resolve(process.cwd(), "relative/skip");
			expect(options?.ignored).toEqual(
				expect.arrayContaining([
					"/project/src/generated",
					"/project/src/generated/**",
					relativeSkip,
					`${relativeSkip}/**`,
				]),
			);
		});

		it("ignores a changed path whose extension isn't in the (default) allow-list", async () => {
			runWorker({ name: "web", command: "node", watch: ["/project/src"] });
			watcher.emit("all", "change", "/project/src/index.css");
			await vi.advanceTimersByTimeAsync(RESTART_DEBOUNCE_MS);
			expect(treeKillCalls).toEqual([]);
			expect(spawnCalls).toHaveLength(1);
		});

		it("ignores a changed path with no extension at all (e.g. a bare trailing dot)", async () => {
			runWorker({ name: "web", command: "node", watch: ["/project/src"] });
			watcher.emit("all", "change", "/project/src/Makefile.");
			await vi.advanceTimersByTimeAsync(RESTART_DEBOUNCE_MS);
			expect(spawnCalls).toHaveLength(1);
		});

		it("honors a custom, case-insensitive ext list instead of the ts/js/json default", async () => {
			runWorker({
				name: "web",
				command: "node",
				watch: ["/project/src"],
				ext: "TRIGGER",
			});
			const firstChild = lastChild();

			watcher.emit("all", "change", "/project/src/app.ts");
			await vi.advanceTimersByTimeAsync(RESTART_DEBOUNCE_MS);
			expect(treeKillCalls).toEqual([]); // .ts no longer matches once ext is overridden

			watcher.emit("all", "change", "/project/src/app.TRIGGER");
			await vi.advanceTimersByTimeAsync(RESTART_DEBOUNCE_MS);
			expect(treeKillCalls).toHaveLength(1); // matched case-insensitively

			firstChild.emit("exit", 0);
			await vi.advanceTimersByTimeAsync(0);
			expect(spawnCalls).toHaveLength(2);
		});

		it("coalesces several rapid matching changes into a single restart", async () => {
			runWorker({ name: "web", command: "node", watch: ["/project/src"] });
			const firstChild = lastChild();

			watcher.emit("all", "change", "/project/src/a.ts");
			await vi.advanceTimersByTimeAsync(RESTART_DEBOUNCE_MS / 2);
			watcher.emit("all", "change", "/project/src/b.ts"); // resets the debounce timer
			await vi.advanceTimersByTimeAsync(RESTART_DEBOUNCE_MS / 2);
			expect(treeKillCalls).toEqual([]); // the first timer was cleared before firing

			await vi.advanceTimersByTimeAsync(RESTART_DEBOUNCE_MS / 2);
			expect(treeKillCalls).toHaveLength(1); // now it fires, exactly once

			firstChild.emit("exit", 0);
			await vi.advanceTimersByTimeAsync(0);
			expect(spawnCalls).toHaveLength(2);
		});

		it("ignores a change that arrives while a restart is already in progress, before the debounce timer is even set", async () => {
			runWorker({ name: "web", command: "node", watch: ["/project/src"] });
			const firstChild = lastChild();

			watcher.emit("all", "change", "/project/src/index.ts");
			await vi.advanceTimersByTimeAsync(RESTART_DEBOUNCE_MS);
			expect(treeKillCalls).toHaveLength(1); // restarting is now true, awaiting the old child's exit

			watcher.emit("all", "change", "/project/src/other.ts");
			await vi.advanceTimersByTimeAsync(RESTART_DEBOUNCE_MS);
			expect(treeKillCalls).toHaveLength(1); // dropped outright - not even coalesced

			firstChild.emit("exit", 0);
			await vi.advanceTimersByTimeAsync(0);
			expect(spawnCalls).toHaveLength(2); // exactly one respawn from the one in-flight restart
		});

		it("on a matching change: sends restart, SIGTERMs the current child, waits for it, then respawns and sends started", async () => {
			runWorker({ name: "web", command: "node", watch: ["/project/src"] });
			const firstChild = lastChild();

			watcher.emit("all", "change", "/project/src/index.ts");
			await vi.advanceTimersByTimeAsync(RESTART_DEBOUNCE_MS);

			expect(sentMessages).toContainEqual({
				source: "braid-worker",
				type: "restart",
			});
			expect(treeKillCalls).toEqual([
				{ pid: firstChild.pid, signal: "SIGTERM" },
			]);
			expect(spawnCalls).toHaveLength(1); // still waiting on the old child to actually die
			expect(stderrWrites.join("")).toContain("stopping (restarting)");

			firstChild.emit("exit", 0);
			await vi.advanceTimersByTimeAsync(0);

			expect(spawnCalls).toHaveLength(2);
			expect(sentMessages).toContainEqual({
				source: "braid-worker",
				type: "started",
			});
		});

		it("escalates to SIGKILL when the app doesn't exit within stopTimeoutMs of SIGTERM", async () => {
			runWorker({
				name: "web",
				command: "node",
				watch: ["/project/src"],
				stopTimeoutMs: 200,
			});
			const firstChild = lastChild();

			watcher.emit("all", "change", "/project/src/index.ts");
			await vi.advanceTimersByTimeAsync(RESTART_DEBOUNCE_MS);
			expect(treeKillCalls).toEqual([
				{ pid: firstChild.pid, signal: "SIGTERM" },
			]);

			await vi.advanceTimersByTimeAsync(200); // app ignores SIGTERM
			expect(treeKillCalls).toEqual([
				{ pid: firstChild.pid, signal: "SIGTERM" },
				{ pid: firstChild.pid, signal: "SIGKILL" },
			]);
			expect(stderrWrites.join("")).toContain(
				"did not exit within 200ms of SIGTERM; sending SIGKILL",
			);
			expect(spawnCalls).toHaveLength(1); // only respawns once it actually dies

			firstChild.emit("exit", null);
			await vi.advanceTimersByTimeAsync(0);
			expect(spawnCalls).toHaveLength(2);
		});

		it("goes idle (does not exit the worker) after a clean exit, then restarts fresh - no kill needed - on the next change", async () => {
			runWorker({ name: "web", command: "node", watch: ["/project/src"] });
			const firstChild = lastChild();

			firstChild.emit("exit", 0);
			expect(exitCalls).toEqual([]);
			expect(sentMessages).toEqual([]);

			watcher.emit("all", "change", "/project/src/index.ts");
			await vi.advanceTimersByTimeAsync(RESTART_DEBOUNCE_MS);
			await vi.advanceTimersByTimeAsync(0);

			expect(treeKillCalls).toEqual([]); // nothing alive to kill
			expect(spawnCalls).toHaveLength(2);
			expect(sentMessages).toContainEqual({
				source: "braid-worker",
				type: "started",
			});
		});

		it("reports a crash but stays alive (goes idle) on a nonzero exit while watched", async () => {
			runWorker({ name: "web", command: "node", watch: ["/project/src"] });
			const firstChild = lastChild();

			firstChild.emit("exit", 7);
			expect(sentMessages).toEqual([
				{ source: "braid-worker", type: "crash", code: 7 },
			]);
			expect(exitCalls).toEqual([]);

			watcher.emit("all", "change", "/project/src/index.ts");
			await vi.advanceTimersByTimeAsync(RESTART_DEBOUNCE_MS);
			await vi.advanceTimersByTimeAsync(0);
			expect(treeKillCalls).toEqual([]);
			expect(spawnCalls).toHaveLength(2);
		});

		it("runs beforeRestart between the old process dying and the new one starting, retrying once on failure", async () => {
			runWorker({
				name: "web",
				command: "node",
				watch: ["/project/src"],
				beforeRestart: {
					command: "make",
					args: ["generate"],
					retries: 1,
					retryDelayMs: 50,
				},
			});
			const firstChild = lastChild();

			watcher.emit("all", "change", "/project/src/index.ts");
			await vi.advanceTimersByTimeAsync(RESTART_DEBOUNCE_MS);
			firstChild.emit("exit", 0);
			await vi.advanceTimersByTimeAsync(0);

			expect(spawnCalls).toHaveLength(2); // old app dead, hook spawned, app not yet respawned
			expect(spawnCalls[1].command).toBe("make");
			expect(spawnCalls[1].args).toEqual(["generate"]);

			// A hook's own output is piped through the very same prefixers the app's output uses.
			spawnCalls[1].child.stdout.emit("data", Buffer.from("generating...\n"));
			spawnCalls[1].child.stderr.emit("data", Buffer.from("a warning\n"));
			expect(stdoutWrites.join("")).toContain(
				`${colorize("[web]", undefined)} generating...\n`,
			);
			expect(stderrWrites.join("")).toContain(
				`${colorize("[web]", undefined)} a warning\n`,
			);

			spawnCalls[1].child.emit("exit", 1); // first attempt fails
			await vi.advanceTimersByTimeAsync(50); // retryDelayMs
			expect(spawnCalls).toHaveLength(3); // retried

			spawnCalls[2].child.emit("exit", 0); // second attempt succeeds
			await vi.advanceTimersByTimeAsync(0);

			expect(spawnCalls).toHaveLength(4); // only now does the app itself respawn
			expect(spawnCalls[3].command).toBe("node");
			expect(sentMessages).toContainEqual({
				source: "braid-worker",
				type: "started",
			});
		});

		it("resolves beforeRestart's cwd relative to the worker's own cwd", async () => {
			runWorker({
				name: "web",
				command: "node",
				watch: ["/project/src"],
				beforeRestart: { command: "make", cwd: "scripts" },
			});
			const firstChild = lastChild();
			watcher.emit("all", "change", "/project/src/index.ts");
			await vi.advanceTimersByTimeAsync(RESTART_DEBOUNCE_MS);
			firstChild.emit("exit", 0);
			await vi.advanceTimersByTimeAsync(0);

			expect(spawnCalls[1].options.cwd).toBe(join(process.cwd(), "scripts"));
		});

		it("leaves the process stopped (no respawn) when beforeRestart keeps failing past its retries, but the next change retries the whole cycle", async () => {
			runWorker({
				name: "web",
				command: "node",
				watch: ["/project/src"],
				beforeRestart: { command: "make", retries: 0, retryDelayMs: 0 },
			});
			const firstChild = lastChild();

			watcher.emit("all", "change", "/project/src/index.ts");
			await vi.advanceTimersByTimeAsync(RESTART_DEBOUNCE_MS);
			firstChild.emit("exit", 0);
			await vi.advanceTimersByTimeAsync(0);

			expect(spawnCalls).toHaveLength(2); // just the one (failing) hook attempt so far
			spawnCalls[1].child.emit("exit", 1);
			await vi.advanceTimersByTimeAsync(0);

			expect(spawnCalls).toHaveLength(2); // never respawned
			expect(stderrWrites.join("")).toContain(
				'beforeRestart hook "make" kept failing; leaving it stopped',
			);
			expect(sentMessages).not.toContainEqual({
				source: "braid-worker",
				type: "started",
			});

			// `restarting` must have been reset in the `finally` block despite the early return above
			// - proven by the watcher still reacting to a further change. `child` is still null (the
			// app was never respawned), so this cycle also exercises the "nothing alive to kill"
			// skip-kill path: no *new* treeKill call, on top of the one from the original alive child.
			const treeKillCallsBefore = treeKillCalls.length;
			watcher.emit("all", "change", "/project/src/index.ts");
			await vi.advanceTimersByTimeAsync(RESTART_DEBOUNCE_MS);
			expect(treeKillCalls).toHaveLength(treeKillCallsBefore);
			expect(spawnCalls).toHaveLength(3); // a fresh hook attempt for the retried cycle
		});

		it("treats a hook spawn error as a failed attempt rather than hanging", async () => {
			runWorker({
				name: "web",
				command: "node",
				watch: ["/project/src"],
				beforeRestart: { command: "does-not-exist", retries: 0 },
			});
			const firstChild = lastChild();
			watcher.emit("all", "change", "/project/src/index.ts");
			await vi.advanceTimersByTimeAsync(RESTART_DEBOUNCE_MS);
			firstChild.emit("exit", 0);
			await vi.advanceTimersByTimeAsync(0);

			spawnCalls[1].child.emit("error", new Error("ENOENT"));
			await vi.advanceTimersByTimeAsync(0);

			expect(spawnCalls).toHaveLength(2); // never respawned - the hook errored, not exited
			expect(stderrWrites.join("")).toContain(
				"kept failing; leaving it stopped",
			);
		});
	});
});
