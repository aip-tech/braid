import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { braidTag, colorize, linePrefixer, pluginTag } from "./prefix.js";

function collectingSink(): { lines: string[]; sink: (line: string) => void } {
	const lines: string[] = [];
	return { lines, sink: (line) => lines.push(line) };
}

describe("colorize", () => {
	it("wraps text in the matching ANSI color code", () => {
		expect(colorize("[api]", "blue")).toBe("\x1b[34m[api]\x1b[0m");
	});

	it("returns the text unchanged when no color is given", () => {
		expect(colorize("[api]")).toBe("[api]");
	});

	it("returns the text unchanged for an unknown color name", () => {
		expect(colorize("[api]", "not-a-color")).toBe("[api]");
	});
});

describe("braidTag", () => {
	it("colors [braid] a fixed neutral color, distinct from any process's own color", () => {
		expect(braidTag()).toBe(colorize("[braid]", "gray"));
	});
});

describe("pluginTag", () => {
	it("colors [plugin:name] the same fixed neutral color as braidTag", () => {
		expect(pluginTag("ui")).toBe(colorize("[plugin:ui]", "gray"));
	});
});

describe("linePrefixer", () => {
	it("prefixes each complete line and holds back a trailing partial line", () => {
		const { lines, sink } = collectingSink();
		const prefixer = linePrefixer(sink, "api", "blue");

		prefixer.write("first line\nsecond line\npartial");

		expect(lines).toEqual([
			`${colorize("[api]", "blue")} first line\n`,
			`${colorize("[api]", "blue")} second line\n`,
		]);
	});

	it("completes a buffered partial line once a newline arrives in a later chunk", () => {
		const { lines, sink } = collectingSink();
		const prefixer = linePrefixer(sink, "api");

		prefixer.write("hello ");
		prefixer.write("world\n");

		expect(lines).toEqual(["[api] hello world\n"]);
	});

	it("flush writes out a trailing partial line with no newline", () => {
		const { lines, sink } = collectingSink();
		const prefixer = linePrefixer(sink, "api");

		prefixer.write("no newline yet");
		prefixer.flush();

		expect(lines).toEqual(["[api] no newline yet\n"]);
	});

	it("flush is a no-op when there is no buffered content", () => {
		const { lines, sink } = collectingSink();
		const prefixer = linePrefixer(sink, "api");

		prefixer.write("complete line\n");
		prefixer.flush();

		expect(lines).toEqual(["[api] complete line\n"]);
	});

	describe("timestamps", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("prepends a gray HH:MM:SS.mmm timestamp before the name prefix when enabled", () => {
			vi.setSystemTime(new Date(2026, 0, 1, 9, 5, 3, 42));
			const { lines, sink } = collectingSink();
			const prefixer = linePrefixer(sink, "api", "blue", true);

			prefixer.write("hello\n");

			expect(lines).toEqual([
				`${colorize("09:05:03.042", "gray")} ${colorize("[api]", "blue")} hello\n`,
			]);
		});

		it("stamps each line in a multi-line chunk independently, not once per chunk", () => {
			vi.setSystemTime(new Date(2026, 0, 1, 9, 5, 3, 0));
			const { lines, sink } = collectingSink();
			const prefixer = linePrefixer(sink, "api", undefined, true);

			prefixer.write("first\n");
			vi.setSystemTime(new Date(2026, 0, 1, 9, 5, 4, 0));
			prefixer.write("second\n");

			expect(lines).toEqual([
				`${colorize("09:05:03.000", "gray")} [api] first\n`,
				`${colorize("09:05:04.000", "gray")} [api] second\n`,
			]);
		});

		it("leaves the prefix unchanged when timestamps is omitted (default false)", () => {
			const { lines, sink } = collectingSink();
			const prefixer = linePrefixer(sink, "api", "blue");

			prefixer.write("hello\n");

			expect(lines).toEqual([`${colorize("[api]", "blue")} hello\n`]);
		});
	});
});
