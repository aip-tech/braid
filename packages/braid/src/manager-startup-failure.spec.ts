import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Startup failures that can't be provoked for real: the control server failing to bind, and the
// first pidfile write failing once every process has already forked. Both must leave nothing
// behind - no start lock (or a later start is refused), and no running process.
const hooks = vi.hoisted(() => ({
	failListen: false,
	failPidfileWrite: false,
}));
vi.mock("./control-server.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./control-server.js")>();
	return {
		...actual,
		createControlServer: () => {
			const server = actual.createControlServer();
			if (!hooks.failListen) return server;
			return {
				...server,
				listen: async () => {
					throw new Error("listen EADDRINUSE");
				},
			};
		},
	};
});
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		renameSync: (from: string, to: string) => {
			if (hooks.failPidfileWrite && to.endsWith("run.json")) {
				throw new Error("ENOSPC: no space left on device");
			}
			actual.renameSync(from, to);
		},
	};
});

const { runManager, stopFromPidfile } = await import("./manager.js");

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");

describe("runManager startup failures", () => {
	let tmpDir: string;
	let pidfilePath: string;
	const keepAlive = [
		{ name: "solo", command: "node", args: [join(FIXTURES, "keep-alive.js")] },
	];

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "braid-startup-failure-"));
		pidfilePath = join(tmpDir, ".braid", "run.json");
		hooks.failListen = false;
		hooks.failPidfileWrite = false;
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("releases the start lock when the control server can't listen, so the next start works", async () => {
		hooks.failListen = true;
		await expect(runManager(keepAlive, pidfilePath)).rejects.toThrow(
			"listen EADDRINUSE",
		);
		expect(existsSync(join(dirname(pidfilePath), "start.lock"))).toBe(false);

		hooks.failListen = false;
		const managerPromise = runManager(keepAlive, pidfilePath);
		await vi.waitFor(() => expect(existsSync(pidfilePath)).toBe(true));
		await stopFromPidfile(pidfilePath);
		expect(await managerPromise).toBe(0);
	}, 15000);

	it("stops every process it already forked, and releases the lock, when the first pidfile write fails", async () => {
		hooks.failPidfileWrite = true;
		// A marker unique to this run, so leftover processes can be found by command line.
		const marker = `braid-startup-failure-${process.pid}-${Date.now()}`;
		const stderr = vi.spyOn(process.stderr, "write");
		await expect(
			runManager(
				[
					{
						name: "solo",
						command: "node",
						args: [join(FIXTURES, "keep-alive.js"), marker],
					},
				],
				pidfilePath,
			),
		).rejects.toThrow("ENOSPC");
		stderr.mockRestore();

		expect(existsSync(join(dirname(pidfilePath), "start.lock"))).toBe(false);
		const leftovers = () =>
			spawnSync("pgrep", ["-f", marker], { encoding: "utf8" }).stdout.trim();
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(leftovers()).toBe("");
	}, 15000);
});
