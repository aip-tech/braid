import { describe, expect, it, vi } from "vitest";

const resolveEsmMock = vi.fn((specifier: string, parentUrl: string) => {
	return `file:///resolved/${specifier}-for-${parentUrl}`;
});
vi.mock("import-meta-resolve", () => ({
	resolve: (specifier: string, parentUrl: string) =>
		resolveEsmMock(specifier, parentUrl),
}));

const { isRunningFromSource, siblingModulePath, sourceExecArgv } = await import(
	"./module-path.js"
);

describe("siblingModulePath", () => {
	it("resolves a sibling .ts file next to a .ts caller", () => {
		expect(siblingModulePath("file:///project/src/manager.ts", "worker")).toBe(
			"/project/src/worker.ts",
		);
	});

	it("resolves a sibling .js file next to a compiled .js caller", () => {
		expect(siblingModulePath("file:///project/dist/manager.js", "worker")).toBe(
			"/project/dist/worker.js",
		);
	});
});

describe("isRunningFromSource", () => {
	it("is true for a .ts module URL", () => {
		expect(isRunningFromSource("file:///project/src/cli.ts")).toBe(true);
	});

	it("is false for a compiled .js module URL", () => {
		expect(isRunningFromSource("file:///project/dist/cli.js")).toBe(false);
	});
});

describe("sourceExecArgv", () => {
	it("returns no extra execArgv when not running from source", () => {
		expect(sourceExecArgv("file:///project/dist/cli.js")).toEqual([]);
		expect(resolveEsmMock).not.toHaveBeenCalled();
	});

	it("resolves tsx's loader relative to the caller and returns a --import execArgv when running from source", () => {
		const callerUrl = "file:///project/src/cli.ts";
		const result = sourceExecArgv(callerUrl);
		expect(resolveEsmMock).toHaveBeenCalledWith("tsx", callerUrl);
		expect(result).toEqual(["--import", resolveEsmMock.mock.results[0].value]);
	});
});
