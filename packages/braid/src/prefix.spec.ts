import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { colorize, linePrefixer } from "./prefix.js";

function collect(stream: PassThrough): string[] {
	const chunks: string[] = [];
	stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
	return chunks;
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

describe("linePrefixer", () => {
	it("prefixes each complete line and holds back a trailing partial line", () => {
		const target = new PassThrough();
		const chunks = collect(target);
		const prefixer = linePrefixer(target, "api", "blue");

		prefixer.write("first line\nsecond line\npartial");

		expect(chunks).toEqual([
			`${colorize("[api]", "blue")} first line\n`,
			`${colorize("[api]", "blue")} second line\n`,
		]);
	});

	it("completes a buffered partial line once a newline arrives in a later chunk", () => {
		const target = new PassThrough();
		const chunks = collect(target);
		const prefixer = linePrefixer(target, "api");

		prefixer.write("hello ");
		prefixer.write("world\n");

		expect(chunks).toEqual(["[api] hello world\n"]);
	});

	it("flush writes out a trailing partial line with no newline", () => {
		const target = new PassThrough();
		const chunks = collect(target);
		const prefixer = linePrefixer(target, "api");

		prefixer.write("no newline yet");
		prefixer.flush();

		expect(chunks).toEqual(["[api] no newline yet\n"]);
	});

	it("flush is a no-op when there is no buffered content", () => {
		const target = new PassThrough();
		const chunks = collect(target);
		const prefixer = linePrefixer(target, "api");

		prefixer.write("complete line\n");
		prefixer.flush();

		expect(chunks).toEqual(["[api] complete line\n"]);
	});
});
