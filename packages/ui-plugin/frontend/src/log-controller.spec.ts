import { describe, expect, it } from "vitest";
import { dropAlreadySeenPrefix, splitIntoLines } from "./log-controller.js";

describe("dropAlreadySeenPrefix", () => {
	it("returns every line unchanged when nothing overlaps", () => {
		expect(dropAlreadySeenPrefix(["a", "b"], ["c", "d"])).toEqual(["c", "d"]);
	});

	it("returns every line unchanged when there's nothing existing to compare against", () => {
		expect(dropAlreadySeenPrefix([], ["a", "b"])).toEqual(["a", "b"]);
	});

	it("drops a varied (non-repeating) overlap in full", () => {
		expect(dropAlreadySeenPrefix(["a", "b", "c"], ["b", "c", "d"])).toEqual([
			"d",
		]);
	});

	it("drops the entire replay when it's fully contained in what's already shown", () => {
		expect(dropAlreadySeenPrefix(["a", "b", "c"], ["b", "c"])).toEqual([]);
	});

	it("drops a single matching line even when it repeats the line before it", () => {
		// The minimum unambiguous case: dropping exactly one duplicate is an acceptable, bounded
		// risk (a genuine reconnect replay is usually literally this), unlike dropping a whole run.
		expect(dropAlreadySeenPrefix(["OK"], ["OK", "new"])).toEqual(["new"]);
	});

	it("does not drop a run of identical lines wholesale, favoring a visible duplicate over losing real output", () => {
		// Regression test: a process logging a repeating "OK" line, then a reconnect replay that
		// happens to start with several more "OK"s (which could be a genuine replay of the same
		// bytes, or brand new output that just repeats the same text) followed by real new content.
		// The old greedy-longest-match behavior dropped the first three "OK"s outright, on the
		// unverifiable assumption they were a replay rather than new output.
		const existing = ["boot", "OK", "OK", "OK"];
		const replay = ["OK", "OK", "OK", "OK", "new"];
		expect(dropAlreadySeenPrefix(existing, replay)).toEqual([
			"OK",
			"OK",
			"OK",
			"new",
		]);
	});

	it("still drops a fully-repeating replay down to a single duplicate line, not zero", () => {
		const existing = ["OK", "OK", "OK"];
		const replay = ["OK", "OK", "OK"];
		expect(dropAlreadySeenPrefix(existing, replay)).toEqual(["OK", "OK"]);
	});
});

describe("splitIntoLines", () => {
	it("buffers a chunk with no newline entirely as the new pending line", () => {
		expect(splitIntoLines("", "partial")).toEqual({
			lines: [],
			pendingLine: "partial",
		});
	});

	it("completes the pending line once its newline arrives, in a later chunk", () => {
		expect(splitIntoLines("Buil", "ding... 42%\n")).toEqual({
			lines: ["Building... 42%"],
			pendingLine: "",
		});
	});

	it("splits multiple complete lines out of a single chunk", () => {
		expect(splitIntoLines("", "one\ntwo\nthree\n")).toEqual({
			lines: ["one", "two", "three"],
			pendingLine: "",
		});
	});

	it("carries over a trailing partial line after emitting the complete ones", () => {
		expect(splitIntoLines("", "one\ntwo\nthree-partial")).toEqual({
			lines: ["one", "two"],
			pendingLine: "three-partial",
		});
	});

	it("prepends any existing pending line to the first line of the new chunk", () => {
		expect(splitIntoLines("pre", "fix\nsecond\n")).toEqual({
			lines: ["prefix", "second"],
			pendingLine: "",
		});
	});

	it("treats a lone newline as one completed empty line", () => {
		expect(splitIntoLines("", "\n")).toEqual({ lines: [""], pendingLine: "" });
	});

	it("is a no-op for an empty chunk", () => {
		expect(splitIntoLines("partial", "")).toEqual({
			lines: [],
			pendingLine: "partial",
		});
	});
});
