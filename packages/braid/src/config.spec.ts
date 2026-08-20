import { describe, expect, it } from "vitest";
import { DEFAULT_LOG_MAX_SIZE_BYTES, defineConfig } from "./config.js";

describe("defineConfig", () => {
	it("passes an explicit logs.maxSizeBytes through unchanged", () => {
		const config = {
			processes: [{ name: "web", command: "pnpm" }],
			plugins: ["some-plugin"],
			logs: { maxSizeBytes: 1024 },
		};
		const result = defineConfig(config);
		expect(result.processes).toEqual(config.processes);
		expect(result.plugins).toEqual(config.plugins);
		expect(result.logs?.maxSizeBytes).toBe(1024);
	});

	it("fills in logs.timestamps as false when omitted", () => {
		const config = { processes: [{ name: "web", command: "pnpm" }] };
		expect(defineConfig(config).logs?.timestamps).toBe(false);
	});

	it("passes an explicit logs.timestamps through unchanged", () => {
		const config = {
			processes: [{ name: "web", command: "pnpm" }],
			logs: { timestamps: true },
		};
		expect(defineConfig(config).logs?.timestamps).toBe(true);
	});

	it("fills in logs.maxSizeBytes when omitted", () => {
		const config = { processes: [{ name: "web", command: "pnpm" }] };
		expect(defineConfig(config).logs?.maxSizeBytes).toBe(
			DEFAULT_LOG_MAX_SIZE_BYTES,
		);
	});

	it("fills in maxSizeBytes without dropping an explicit logs.dir", () => {
		const config = {
			processes: [{ name: "web", command: "pnpm" }],
			logs: { dir: "/custom/logs" },
		};
		const result = defineConfig(config);
		expect(result.logs?.dir).toBe("/custom/logs");
		expect(result.logs?.maxSizeBytes).toBe(DEFAULT_LOG_MAX_SIZE_BYTES);
	});

	it("does not fill in logs.dir - its real default depends on the pidfile path at runtime", () => {
		const config = { processes: [{ name: "web", command: "pnpm" }] };
		expect(defineConfig(config).logs?.dir).toBeUndefined();
	});
});
