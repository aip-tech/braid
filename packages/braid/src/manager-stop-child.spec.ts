import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// stopChild's SIGKILL-escalation branch can't be reached through a real forked worker (see its
// own doc comment in manager.ts) - mocking tree-kill and using a fake child that never emits
// "exit" lets it be driven directly and deterministically instead.
vi.mock("tree-kill", () => ({ default: vi.fn() }));

import treeKill from "tree-kill";
import { stopChild } from "./manager.js";

type FakeChild = EventEmitter & {
	pid: number | undefined;
	exitCode: number | null;
	signalCode: NodeJS.Signals | null;
};

function makeFakeChild(pid: number | undefined): FakeChild {
	return Object.assign(new EventEmitter(), {
		pid,
		exitCode: null,
		signalCode: null,
	});
}

describe("stopChild", () => {
	let treeKillCalls: Array<{ pid: number; signal: string }>;

	beforeEach(() => {
		vi.useFakeTimers();
		treeKillCalls = [];
		vi.mocked(treeKill).mockImplementation(((
			pid: number,
			signal: string,
			callback?: () => void,
		) => {
			treeKillCalls.push({ pid, signal });
			callback?.();
		}) as unknown as typeof treeKill);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("returns immediately without signaling anything when the child has no pid", async () => {
		const child = makeFakeChild(undefined);
		await stopChild(child as unknown as ChildProcess);
		expect(treeKillCalls).toEqual([]);
	});

	it("resolves once the child exits from SIGTERM, without escalating", async () => {
		const child = makeFakeChild(4242);
		const promise = stopChild(child as unknown as ChildProcess, {
			timeoutMs: 5000,
		});
		expect(treeKillCalls).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
		child.emit("exit");
		await promise;
		expect(treeKillCalls).toHaveLength(1); // no SIGKILL follow-up
	});

	it("uses the default timeout when none is given", async () => {
		const child = makeFakeChild(4242);
		const promise = stopChild(child as unknown as ChildProcess);
		child.emit("exit");
		await promise;
		// DEFAULT_STOP_TIMEOUT_MS is 5000 - advancing just short of it must not have escalated
		// (proven below), confirming the omitted-options-object default actually took effect.
		await vi.advanceTimersByTimeAsync(4999);
		expect(treeKillCalls).toHaveLength(1);
	});

	it("escalates to SIGKILL and waits for the real exit when the child never dies from SIGTERM", async () => {
		const child = makeFakeChild(4242);
		const writeSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);

		const promise = stopChild(child as unknown as ChildProcess, {
			timeoutMs: 1000,
			label: "stubborn",
		});
		await vi.advanceTimersByTimeAsync(1000);
		expect(treeKillCalls).toEqual([
			{ pid: 4242, signal: "SIGTERM" },
			{ pid: 4242, signal: "SIGKILL" },
		]);
		expect(
			writeSpy.mock.calls.some((call) =>
				String(call[0]).includes(
					'"stubborn" did not exit within 1000ms of SIGTERM; sending SIGKILL',
				),
			),
		).toBe(true);

		// stopChild's own promise must not resolve until the child *actually* exits, even after
		// SIGKILL has been sent - sending a signal isn't the same as the process being gone.
		let resolved = false;
		void promise.then(() => {
			resolved = true;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(resolved).toBe(false);

		child.emit("exit");
		await promise;
		expect(resolved).toBe(true);

		writeSpy.mockRestore();
	});

	it("falls back to the pid in its log message when no label is given", async () => {
		const child = makeFakeChild(4242);
		const writeSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);

		const promise = stopChild(child as unknown as ChildProcess, {
			timeoutMs: 1000,
		});
		await vi.advanceTimersByTimeAsync(1000);
		expect(
			writeSpy.mock.calls.some((call) =>
				String(call[0]).includes('"4242" did not exit'),
			),
		).toBe(true);

		child.emit("exit");
		await promise;
		writeSpy.mockRestore();
	});

	it("treats a child with exitCode already set as already exited, without waiting", async () => {
		const child = makeFakeChild(4242);
		child.exitCode = 0;
		const promise = stopChild(child as unknown as ChildProcess, {
			timeoutMs: 1000,
		});
		await promise;
		expect(treeKillCalls).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
	});
});
