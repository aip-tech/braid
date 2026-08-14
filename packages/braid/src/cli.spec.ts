import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PIDFILE_PATH, loadConfig, parseArgs, runCli } from "./cli.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "__fixtures__");

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
	it("defaults to process-manager.config.ts resolved against cwd", () => {
		const { command, configPath } = parseArgs(["start"], "/repo");
		expect(command).toBe("start");
		expect(configPath).toBe(join("/repo", "process-manager.config.ts"));
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
});

describe("loadConfig", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "process-manager-cli-test-"));
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

	it("loads a valid TypeScript config's default export", async () => {
		const configPath = join(tmpDir, "valid.config.ts");
		writeFileSync(
			configPath,
			`const config = [{ name: "one", command: "node", args: ["${join(FIXTURES, "keep-alive.js").replace(/\\/g, "\\\\")}"] }];\nexport default config;\n`,
		);
		const config = await loadConfig(configPath);
		expect(config).toHaveLength(1);
		expect(config[0].name).toBe("one");
	});
});

describe("runCli", () => {
	let tmpDir: string;
	let configPath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "process-manager-cli-run-"));
		configPath = join(tmpDir, "process-manager.config.ts");
		const fixture = join(FIXTURES, "keep-alive.js").replace(/\\/g, "\\\\");
		writeFileSync(
			configPath,
			`export default [{ name: "solo", command: "node", args: ["${fixture}"] }];\n`,
		);
	});

	afterEach(() => {
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
});
