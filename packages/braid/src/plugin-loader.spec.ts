import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadExternalPlugins, resolvePluginModule } from "./plugin-loader.js";
import type { PluginContext } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "__fixtures__", "plugins");
// Doesn't need to exist on disk - only anchors relative-path resolution.
const FAKE_CONFIG_PATH = join(__dirname, "braid.config.ts");

function stubContext(): PluginContext {
	return {
		registerRoute: vi.fn(),
		registerStatic: vi.fn(),
		registerUpgrade: vi.fn(),
		on: vi.fn(),
		getProcesses: vi.fn(() => []),
		log: vi.fn(),
	};
}

function contextFactory(): {
	contextFor: (name: string) => PluginContext;
	contexts: Map<string, PluginContext>;
} {
	const contexts = new Map<string, PluginContext>();
	return {
		contextFor: (name: string) => {
			const ctx = stubContext();
			contexts.set(name, ctx);
			return ctx;
		},
		contexts,
	};
}

describe("resolvePluginModule", () => {
	it("resolves a relative entry against the config file's directory", () => {
		const url = resolvePluginModule(
			"./__fixtures__/plugins/ok-plugin.js",
			FAKE_CONFIG_PATH,
		);
		expect(url.pathname).toBe(join(FIXTURES, "ok-plugin.js"));
	});
});

describe("loadExternalPlugins: local fixtures", () => {
	it("loads a relative-path plugin and registers it", async () => {
		const { contextFor, contexts } = contextFactory();
		await loadExternalPlugins(
			["./__fixtures__/plugins/ok-plugin.js"],
			FAKE_CONFIG_PATH,
			contextFor,
		);
		const ctx = contexts.get("ok");
		expect(ctx).toBeDefined();
		expect(ctx?.registerRoute).toHaveBeenCalledWith(
			"GET",
			"/ok",
			expect.any(Function),
		);
	});

	it("passes a config tuple's options through to register()", async () => {
		const { contextFor, contexts } = contextFactory();
		await loadExternalPlugins(
			[["./__fixtures__/plugins/options-echo-plugin.js", { reply: "custom" }]],
			FAKE_CONFIG_PATH,
			contextFor,
		);
		const ctx = contexts.get("options-echo");
		expect(ctx?.log).toHaveBeenCalledWith(JSON.stringify({ reply: "custom" }));
	});

	it("logs and skips (does not throw) a plugin whose register() throws, without blocking others", async () => {
		const { contextFor, contexts } = contextFactory();

		await expect(
			loadExternalPlugins(
				[
					"./__fixtures__/plugins/throwing-plugin.js",
					"./__fixtures__/plugins/ok-plugin.js",
				],
				FAKE_CONFIG_PATH,
				contextFor,
			),
		).resolves.toBeUndefined();

		expect(contexts.get("throwing")?.log).toHaveBeenCalledWith(
			expect.stringContaining("boom"),
		);
		expect(contexts.get("ok")?.registerRoute).toHaveBeenCalled();
	});

	it("logs and skips a missing module without throwing", async () => {
		const writeSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		const { contextFor } = contextFactory();

		await expect(
			loadExternalPlugins(
				["./__fixtures__/plugins/does-not-exist.js"],
				FAKE_CONFIG_PATH,
				contextFor,
			),
		).resolves.toBeUndefined();

		expect(
			writeSpy.mock.calls.some((call) =>
				String(call[0]).includes("does-not-exist"),
			),
		).toBe(true);
		writeSpy.mockRestore();
	});

	it("logs and skips a module whose default export isn't a { name, register } plugin", async () => {
		const writeSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		const tmpDir = mkdtempSync(join(tmpdir(), "braid-plugin-invalid-"));
		const modulePath = join(tmpDir, "invalid-plugin.js");
		writeFileSync(modulePath, "export default { oops: true };\n");
		const { contextFor } = contextFactory();

		await expect(
			loadExternalPlugins(
				["./invalid-plugin.js"],
				join(tmpDir, "braid.config.ts"),
				contextFor,
			),
		).resolves.toBeUndefined();

		expect(
			writeSpy.mock.calls.some((call) =>
				String(call[0]).includes("does not default-export"),
			),
		).toBe(true);
		writeSpy.mockRestore();
		rmSync(tmpDir, { recursive: true, force: true });
	});
});

describe("loadExternalPlugins: bare-specifier resolution from the config author's own node_modules", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "braid-plugin-bare-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function writePackage(
		name: string,
		packageJson: Record<string, unknown>,
	): void {
		const pkgDir = join(tmpDir, "node_modules", name);
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(
			join(pkgDir, "package.json"),
			JSON.stringify({ name, ...packageJson }, null, 2),
		);
		writeFileSync(
			join(pkgDir, "index.js"),
			'export default { name: "' +
				name +
				'", register(ctx) { ctx.log("loaded"); } };\n',
		);
	}

	it("resolves a package with a legacy main field", async () => {
		writePackage("cjs-shaped-plugin", { type: "module", main: "index.js" });
		const { contextFor, contexts } = contextFactory();
		await loadExternalPlugins(
			["cjs-shaped-plugin"],
			join(tmpDir, "braid.config.ts"),
			contextFor,
		);
		expect(contexts.get("cjs-shaped-plugin")?.log).toHaveBeenCalledWith(
			"loaded",
		);
	});

	it('resolves a pure-ESM package whose exports map has only an "import" condition', async () => {
		writePackage("pure-esm-plugin", {
			type: "module",
			exports: { ".": { import: "./index.js" } },
		});
		const { contextFor, contexts } = contextFactory();
		await loadExternalPlugins(
			["pure-esm-plugin"],
			join(tmpDir, "braid.config.ts"),
			contextFor,
		);
		expect(contexts.get("pure-esm-plugin")?.log).toHaveBeenCalledWith("loaded");
	});

	it("logs and skips an unresolvable bare specifier without throwing", async () => {
		const writeSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		const { contextFor } = contextFactory();

		await expect(
			loadExternalPlugins(
				["@this-package/does-not-exist"],
				join(tmpDir, "braid.config.ts"),
				contextFor,
			),
		).resolves.toBeUndefined();

		expect(
			writeSpy.mock.calls.some((call) =>
				String(call[0]).includes("does-not-exist"),
			),
		).toBe(true);
		writeSpy.mockRestore();
	});
});
