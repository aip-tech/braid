import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_PIDFILE_PATH,
	isMainModule,
	loadConfig,
	parseArgs,
	runCli,
} from "./cli.js";
import { stopFromPidfile } from "./manager.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "__fixtures__");

describe("isMainModule", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "braid-is-main-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns false when argv1 is undefined", () => {
		expect(isMainModule(undefined, "file:///anything")).toBe(false);
	});

	it("returns false when argv1 doesn't resolve to a real file", () => {
		expect(isMainModule(join(tmpDir, "missing.js"), "file:///anything")).toBe(
			false,
		);
	});

	// realpathSync matches what Node reports for import.meta.url on a real loaded module.
	it("matches when argv1 is the same real file as moduleUrl", () => {
		const realFile = join(tmpDir, "cli.js");
		writeFileSync(realFile, "");
		const moduleUrl = pathToFileURL(realpathSync(realFile)).href;
		expect(isMainModule(realFile, moduleUrl)).toBe(true);
	});

	it("matches when argv1 is a symlink to moduleUrl's real file (the installed-bin case)", () => {
		const realFile = join(tmpDir, "real-cli.js");
		const symlinkPath = join(tmpDir, "braid");
		writeFileSync(realFile, "");
		symlinkSync(realFile, symlinkPath);

		const moduleUrl = pathToFileURL(realpathSync(realFile)).href;
		expect(isMainModule(symlinkPath, moduleUrl)).toBe(true);
	});

	it("returns false when argv1 resolves to a different file than moduleUrl", () => {
		const realFile = join(tmpDir, "cli.js");
		const otherFile = join(tmpDir, "other.js");
		writeFileSync(realFile, "");
		writeFileSync(otherFile, "");
		expect(isMainModule(otherFile, pathToFileURL(realFile).href)).toBe(false);
	});
});

async function waitFor(
	predicate: () => boolean,
	{ timeoutMs = 4000, intervalMs = 25 } = {},
): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("waitFor: timed out");
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}

describe("parseArgs", () => {
	it("defaults to braid.config.ts resolved against cwd", () => {
		const { command, configPath } = parseArgs(["start"], "/repo");
		expect(command).toBe("start");
		expect(configPath).toBe(join("/repo", "braid.config.ts"));
	});

	it("honors an explicit --config path", () => {
		const { configPath } = parseArgs(
			["start", "--config", "custom.config.ts"],
			"/repo",
		);
		expect(configPath).toBe(join("/repo", "custom.config.ts"));
	});

	it("throws when --config is missing its value", () => {
		expect(() => parseArgs(["start", "--config"], "/repo")).toThrow(
			/requires a path/,
		);
	});

	it("parses a positional process name and --follow/--lines for logs", () => {
		const parsed = parseArgs(
			["logs", "web", "--follow", "--lines", "50"],
			"/repo",
		);
		expect(parsed.processName).toBe("web");
		expect(parsed.follow).toBe(true);
		expect(parsed.lines).toBe(50);
	});

	it("defaults follow to false and lines to undefined with no name given", () => {
		const parsed = parseArgs(["logs"], "/repo");
		expect(parsed.processName).toBeUndefined();
		expect(parsed.follow).toBe(false);
		expect(parsed.lines).toBeUndefined();
	});

	it("throws when --lines isn't a positive number", () => {
		expect(() => parseArgs(["logs", "--lines", "nope"], "/repo")).toThrow(
			/positive number/,
		);
	});
});

describe("loadConfig", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "braid-cli-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("throws when the config file does not exist", async () => {
		await expect(loadConfig(join(tmpDir, "missing.config.ts"))).rejects.toThrow(
			/not found/,
		);
	});

	it("throws when the config does not default-export a non-empty array", async () => {
		const configPath = join(tmpDir, "empty.config.ts");
		writeFileSync(configPath, "export default [];\n");
		await expect(loadConfig(configPath)).rejects.toThrow(/non-empty array/);
	});

	it("loads a valid TypeScript config's default export (bare array form)", async () => {
		const configPath = join(tmpDir, "valid.config.ts");
		writeFileSync(
			configPath,
			`const config = [{ name: "one", command: "node", args: ["${join(FIXTURES, "keep-alive.js").replace(/\\/g, "\\\\")}"] }];\nexport default config;\n`,
		);
		const config = await loadConfig(configPath);
		expect(config.processes).toHaveLength(1);
		expect(config.processes[0].name).toBe("one");
		expect(config.plugins).toBeUndefined();
	});

	it("loads the { processes, plugins } object form", async () => {
		const configPath = join(tmpDir, "valid.config.ts");
		writeFileSync(
			configPath,
			`const config = { processes: [{ name: "one", command: "node", args: ["${join(FIXTURES, "keep-alive.js").replace(/\\/g, "\\\\")}"] }], plugins: ["some-plugin"] };\nexport default config;\n`,
		);
		const config = await loadConfig(configPath);
		expect(config.processes).toHaveLength(1);
		expect(config.plugins).toEqual(["some-plugin"]);
	});

	it("throws when the object form's processes is missing or empty", async () => {
		const configPath = join(tmpDir, "no-processes.config.ts");
		writeFileSync(configPath, "export default { processes: [] };\n");
		await expect(loadConfig(configPath)).rejects.toThrow(/non-empty array/);
	});

	it("throws when the object form's plugins isn't an array", async () => {
		const configPath = join(tmpDir, "bad-plugins.config.ts");
		writeFileSync(
			configPath,
			'export default { processes: [{ name: "one", command: "node" }], plugins: "nope" };\n',
		);
		await expect(loadConfig(configPath)).rejects.toThrow(
			/"plugins" must be an array/,
		);
	});
});

describe("runCli", () => {
	let tmpDir: string;
	let configPath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "braid-cli-run-"));
		configPath = join(tmpDir, "braid.config.ts");
		const fixture = join(FIXTURES, "keep-alive.js").replace(/\\/g, "\\\\");
		writeFileSync(
			configPath,
			`export default [{ name: "solo", command: "node", args: ["${fixture}"] }];\n`,
		);
	});

	afterEach(async () => {
		// Catches any daemon a failed test left running.
		await stopFromPidfile(join(tmpDir, DEFAULT_PIDFILE_PATH)).catch(() => {});
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("prints usage and returns 1 for an unknown command", async () => {
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		const code = await runCli([], tmpDir);
		expect(code).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Usage"));
		errorSpy.mockRestore();
	});

	it("status and stop report nothing running when no pidfile exists", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		expect(await runCli(["status"], tmpDir)).toBe(0);
		expect(await runCli(["stop"], tmpDir)).toBe(0);
		expect(logSpy).toHaveBeenCalledWith("Nothing running.");
		logSpy.mockRestore();
	});

	it("runs start, then status, then stop against the same pidfile end to end", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const pidfilePath = join(tmpDir, DEFAULT_PIDFILE_PATH);

		const startPromise = runCli(["start"], tmpDir);
		await waitFor(() => existsSync(pidfilePath));

		expect(await runCli(["status"], tmpDir)).toBe(0);
		expect(
			logSpy.mock.calls.some(
				(call) =>
					String(call[0]).includes("solo") &&
					String(call[0]).includes("running"),
			),
		).toBe(true);

		expect(await runCli(["stop"], tmpDir)).toBe(0);
		expect(await startPromise).toBe(0);
		expect(existsSync(pidfilePath)).toBe(false);

		logSpy.mockRestore();
	}, 10000);

	it("refuses a second start while one is already running", async () => {
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		const pidfilePath = join(tmpDir, DEFAULT_PIDFILE_PATH);

		const startPromise = runCli(["start"], tmpDir);
		await waitFor(() => existsSync(pidfilePath));

		expect(await runCli(["start"], tmpDir)).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("already running"),
		);

		await runCli(["stop"], tmpDir);
		await startPromise;
		errorSpy.mockRestore();
	}, 10000);

	it("prints the daemon's pid on a successful start and leaves a daemon.log behind", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const pidfilePath = join(tmpDir, DEFAULT_PIDFILE_PATH);

		const code = await runCli(["start"], tmpDir);
		expect(code).toBe(0);
		expect(
			logSpy.mock.calls.some((call) =>
				/braid: started \(pid \d+\)/.test(String(call[0])),
			),
		).toBe(true);
		expect(existsSync(join(tmpDir, ".braid", "daemon.log"))).toBe(true);

		await stopFromPidfile(pidfilePath);
		logSpy.mockRestore();
	}, 10000);

	it("surfaces a useful error, including the daemon.log tail, when the daemon fails to start", async () => {
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		// A directory at the pidfile's path makes writeFileSync throw inside the daemon.
		mkdirSync(join(tmpDir, ".braid", "run.json"), { recursive: true });

		const code = await runCli(["start"], tmpDir);
		expect(code).toBe(1);
		expect(
			errorSpy.mock.calls.some((call) => String(call[0]).startsWith("braid:")),
		).toBe(true);
		const daemonLog = readFileSync(
			join(tmpDir, ".braid", "daemon.log"),
			"utf8",
		);
		expect(daemonLog).toContain("daemon failed to start");

		errorSpy.mockRestore();
	}, 10000);

	describe("logs", () => {
		it("reports nothing running when no daemon is running", async () => {
			const logSpy = vi
				.spyOn(console, "log")
				.mockImplementation(() => undefined);
			expect(await runCli(["logs"], tmpDir)).toBe(0);
			expect(logSpy).toHaveBeenCalledWith("Nothing running.");
			logSpy.mockRestore();
		});

		it("streams a running process's log, honors --lines and a name filter", async () => {
			const writeSpy = vi
				.spyOn(process.stdout, "write")
				.mockImplementation(() => true);
			const pidfilePath = join(tmpDir, DEFAULT_PIDFILE_PATH);

			expect(await runCli(["start"], tmpDir)).toBe(0);
			const logPath = join(tmpDir, ".braid", "logs", "solo.log");
			await waitFor(
				() => existsSync(logPath) && readFileSync(logPath, "utf8").length > 0,
			);

			expect(await runCli(["logs", "solo"], tmpDir)).toBe(0);
			expect(
				writeSpy.mock.calls.some((call) =>
					Buffer.from(call[0]).toString().includes("[solo]"),
				),
			).toBe(true);

			expect(await runCli(["logs", "solo", "--lines", "1"], tmpDir)).toBe(0);

			// An unconfigured name 404s cleanly rather than streaming anything.
			writeSpy.mockClear();
			expect(await runCli(["logs", "nonexistent"], tmpDir)).toBe(1);

			await stopFromPidfile(pidfilePath);
			writeSpy.mockRestore();
		}, 10000);

		it.each([
			"SIGINT",
			"SIGTERM",
		] as const)("exits cleanly on %s during --follow, instead of dying from the raw signal", async (signal) => {
			const writeSpy = vi
				.spyOn(process.stdout, "write")
				.mockImplementation(() => true);
			const pidfilePath = join(tmpDir, DEFAULT_PIDFILE_PATH);

			expect(await runCli(["start"], tmpDir)).toBe(0);
			const logsPromise = runCli(["logs", "solo", "--follow"], tmpDir);
			await new Promise((resolve) => setTimeout(resolve, 200));
			// process.emit, not process.kill: triggers the listener without signaling the whole test runner.
			process.emit(signal);

			expect(await logsPromise).toBe(0);

			await stopFromPidfile(pidfilePath);
			writeSpy.mockRestore();
		}, 10000);
	});
});
