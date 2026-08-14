import {
	existsSync,
	mkdtempSync,
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

	// import.meta.url for a real loaded module always reports the canonical (realpath'd) location,
	// which on macOS differs from a freshly-built tmpdir path (/var/folders/... -> /private/var/...)
	// - so tests build the expected moduleUrl via realpathSync too, matching what Node actually does.
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
		tmpDir = mkdtempSync(join(tmpdir(), "braid-cli-run-"));
		configPath = join(tmpDir, "braid.config.ts");
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
