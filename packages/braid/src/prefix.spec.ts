import { describe, expect, it } from "vitest";
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
});
