import { describe, expect, it } from "vitest";
import {
	findDependencyCycle,
	findStartAfterCycle,
	validateAutoStart,
	validateDependsOn,
	validateReadyPattern,
	validateStartAfter,
	validateUniqueNames,
} from "./dependency-graph.js";
import type { ProcessConfig } from "./types.js";

function config(name: string, dependsOnProcesses?: string[]): ProcessConfig {
	return {
		name,
		command: "node",
		...(dependsOnProcesses
			? { dependsOn: { processes: dependsOnProcesses } }
			: {}),
	};
}

function startAfterConfig(
	name: string,
	startAfterProcesses?: string[],
	autoStart?: boolean,
): ProcessConfig {
	return {
		name,
		command: "node",
		...(startAfterProcesses
			? { startAfter: { processes: startAfterProcesses } }
			: {}),
		...(autoStart !== undefined ? { autoStart } : {}),
	};
}

describe("findDependencyCycle", () => {
	it("returns undefined when no process declares dependsOn", () => {
		const configs = [config("api"), config("client")];
		expect(findDependencyCycle(configs)).toBeUndefined();
	});

	it("returns undefined for a valid chain with no cycle", () => {
		const configs = [
			config("api"),
			config("client", ["api"]),
			config("widget", ["client"]),
		];
		expect(findDependencyCycle(configs)).toBeUndefined();
	});

	it("returns undefined when multiple processes depend on the same one", () => {
		const configs = [
			config("api"),
			config("client-a", ["api"]),
			config("client-b", ["api"]),
		];
		expect(findDependencyCycle(configs)).toBeUndefined();
	});

	it("detects a direct two-node cycle", () => {
		const configs = [config("a", ["b"]), config("b", ["a"])];
		const cycle = findDependencyCycle(configs);
		expect(cycle).toBeDefined();
		expect(cycle).toContain("a");
		expect(cycle).toContain("b");
		expect(cycle?.at(0)).toBe(cycle?.at(-1));
	});

	it("detects a longer transitive cycle", () => {
		const configs = [
			config("a", ["b"]),
			config("b", ["c"]),
			config("c", ["a"]),
		];
		const cycle = findDependencyCycle(configs);
		expect(cycle).toEqual(["a", "b", "c", "a"]);
	});

	it("ignores an unrelated branch when finding a cycle elsewhere", () => {
		const configs = [
			config("standalone"),
			config("a", ["b"]),
			config("b", ["a"]),
		];
		expect(findDependencyCycle(configs)).toBeDefined();
	});
});

describe("validateDependsOn", () => {
	it("does not throw for configs with no dependsOn", () => {
		expect(() =>
			validateDependsOn([config("api"), config("client")]),
		).not.toThrow();
	});

	it("does not throw for a valid dependency chain", () => {
		expect(() =>
			validateDependsOn([config("api"), config("client", ["api"])]),
		).not.toThrow();
	});

	it("throws when a process depends on itself", () => {
		expect(() => validateDependsOn([config("api", ["api"])])).toThrow(
			/"api" cannot depend on itself/,
		);
	});

	it("throws when a process depends on an unknown process", () => {
		expect(() =>
			validateDependsOn([config("client", ["missing-api"])]),
		).toThrow(/"client" depends on unknown process "missing-api"/);
	});

	it("throws with the cycle path when two processes depend on each other", () => {
		expect(() =>
			validateDependsOn([config("api", ["client"]), config("client", ["api"])]),
		).toThrow(
			/circular restart dependency: (api -> client -> api|client -> api -> client)/,
		);
	});

	it("throws with the cycle path for a longer transitive loop", () => {
		expect(() =>
			validateDependsOn([
				config("a", ["b"]),
				config("b", ["c"]),
				config("c", ["a"]),
			]),
		).toThrow(/circular restart dependency: a -> b -> c -> a/);
	});
});

describe("findStartAfterCycle", () => {
	it("returns undefined when no process declares startAfter", () => {
		const configs = [startAfterConfig("api"), startAfterConfig("client")];
		expect(findStartAfterCycle(configs)).toBeUndefined();
	});

	it("returns undefined for a valid chain with no cycle", () => {
		const configs = [
			startAfterConfig("api"),
			startAfterConfig("client", ["api"]),
			startAfterConfig("widget", ["client"]),
		];
		expect(findStartAfterCycle(configs)).toBeUndefined();
	});

	it("returns undefined when multiple processes start after the same one", () => {
		const configs = [
			startAfterConfig("api"),
			startAfterConfig("client-a", ["api"]),
			startAfterConfig("client-b", ["api"]),
		];
		expect(findStartAfterCycle(configs)).toBeUndefined();
	});

	it("detects a direct two-node cycle", () => {
		const configs = [
			startAfterConfig("a", ["b"]),
			startAfterConfig("b", ["a"]),
		];
		const cycle = findStartAfterCycle(configs);
		expect(cycle).toBeDefined();
		expect(cycle).toContain("a");
		expect(cycle).toContain("b");
		expect(cycle?.at(0)).toBe(cycle?.at(-1));
	});

	it("detects a longer transitive cycle", () => {
		const configs = [
			startAfterConfig("a", ["b"]),
			startAfterConfig("b", ["c"]),
			startAfterConfig("c", ["a"]),
		];
		const cycle = findStartAfterCycle(configs);
		expect(cycle).toEqual(["a", "b", "c", "a"]);
	});

	it("ignores an unrelated branch when finding a cycle elsewhere", () => {
		const configs = [
			startAfterConfig("standalone"),
			startAfterConfig("a", ["b"]),
			startAfterConfig("b", ["a"]),
		];
		expect(findStartAfterCycle(configs)).toBeDefined();
	});
});

describe("validateStartAfter", () => {
	it("does not throw for configs with no startAfter", () => {
		expect(() =>
			validateStartAfter([startAfterConfig("api"), startAfterConfig("client")]),
		).not.toThrow();
	});

	it("does not throw for a valid startAfter chain", () => {
		expect(() =>
			validateStartAfter([
				startAfterConfig("api"),
				startAfterConfig("client", ["api"]),
			]),
		).not.toThrow();
	});

	it("throws when a process starts after itself", () => {
		expect(() =>
			validateStartAfter([startAfterConfig("api", ["api"])]),
		).toThrow(/"api" cannot start after itself/);
	});

	it("throws when a process starts after an unknown process", () => {
		expect(() =>
			validateStartAfter([startAfterConfig("client", ["missing-api"])]),
		).toThrow(/"client" starts after unknown process "missing-api"/);
	});

	it("throws with the cycle path when two processes start after each other", () => {
		expect(() =>
			validateStartAfter([
				startAfterConfig("api", ["client"]),
				startAfterConfig("client", ["api"]),
			]),
		).toThrow(
			/circular startup dependency: (api -> client -> api|client -> api -> client)/,
		);
	});

	it("throws with the cycle path for a longer transitive loop", () => {
		expect(() =>
			validateStartAfter([
				startAfterConfig("a", ["b"]),
				startAfterConfig("b", ["c"]),
				startAfterConfig("c", ["a"]),
			]),
		).toThrow(/circular startup dependency: a -> b -> c -> a/);
	});

	it("throws when a startAfter target has autoStart: false", () => {
		expect(() =>
			validateStartAfter([
				startAfterConfig("client", ["api"]),
				startAfterConfig("api", undefined, false),
			]),
		).toThrow(/"client" starts after "api", but "api" has autoStart: false/);
	});

	it("does not throw when the startAfter *dependent* (not the target) has autoStart: false", () => {
		expect(() =>
			validateStartAfter([
				startAfterConfig("cron", ["api"], false),
				startAfterConfig("api"),
			]),
		).not.toThrow();
	});
});

describe("validateAutoStart", () => {
	it("does not throw for a plain autoStart: false process with no dependsOn", () => {
		const cron: ProcessConfig = {
			name: "cron",
			command: "node",
			autoStart: false,
		};
		expect(() => validateAutoStart([cron])).not.toThrow();
	});

	it("does not throw when autoStart is left at its default (true) alongside dependsOn", () => {
		expect(() =>
			validateAutoStart([config("api"), config("client", ["api"])]),
		).not.toThrow();
	});

	it("throws when a process combines autoStart: false with a non-empty dependsOn", () => {
		const cron: ProcessConfig = {
			name: "cron",
			command: "node",
			autoStart: false,
			dependsOn: { processes: ["api"] },
		};
		expect(() => validateAutoStart([config("api"), cron])).toThrow(
			/"cron" has autoStart: false and also declares dependsOn/,
		);
	});
});

describe("validateUniqueNames", () => {
	it("does not throw when every process name is unique", () => {
		expect(() =>
			validateUniqueNames([config("api"), config("client")]),
		).not.toThrow();
	});

	it("does not throw for a single process", () => {
		expect(() => validateUniqueNames([config("solo")])).not.toThrow();
	});

	it("throws when two processes share the same name", () => {
		expect(() =>
			validateUniqueNames([config("worker"), config("worker")]),
		).toThrow(/duplicate process name "worker"/);
	});
});

describe("validateReadyPattern", () => {
	it("does not throw when no process sets readyPattern", () => {
		expect(() => validateReadyPattern([config("api")])).not.toThrow();
	});

	it("does not throw for a valid readyPattern", () => {
		const api: ProcessConfig = {
			name: "api",
			command: "node",
			readyPattern: "Server listening",
		};
		expect(() => validateReadyPattern([api])).not.toThrow();
	});

	it("throws a clear startup error for an invalid readyPattern regex, instead of letting it surface later as a crash", () => {
		const api: ProcessConfig = {
			name: "api",
			command: "node",
			readyPattern: "(",
		};
		expect(() => validateReadyPattern([api])).toThrow(
			/"api" has an invalid readyPattern "\("/,
		);
	});
});
