// @vitest-environment jsdom
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Sparkline } from "./sparkline.js";

let container: HTMLDivElement;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
});

afterEach(() => {
	act(() => render(null, container));
	container.remove();
});

describe("Sparkline", () => {
	it("renders nothing with fewer than two values", () => {
		act(() => render(<Sparkline values={[]} />, container));
		expect(container.querySelector("svg")).toBeNull();

		act(() => render(<Sparkline values={[5]} />, container));
		expect(container.querySelector("svg")).toBeNull();
	});

	it("renders an svg with one point per value once there are at least two", () => {
		act(() => render(<Sparkline values={[1, 2, 3]} />, container));
		const polyline = container.querySelector("polyline");
		expect(polyline).not.toBeNull();
		expect(polyline?.getAttribute("points")?.trim().split(" ")).toHaveLength(3);
	});

	it("does not divide by zero (and does not crash) when every value is 0", () => {
		act(() => render(<Sparkline values={[0, 0, 0]} />, container));
		const points = container.querySelector("polyline")?.getAttribute("points");
		expect(points).toBeTruthy();
		for (const pair of points?.trim().split(" ") ?? []) {
			const [, y] = pair.split(",").map(Number);
			expect(Number.isFinite(y)).toBe(true);
		}
	});

	it("scales the highest value to the top of the chart (y = 0)", () => {
		act(() => render(<Sparkline values={[0, 10]} height={32} />, container));
		const points = container
			.querySelector("polyline")
			?.getAttribute("points")
			?.trim()
			.split(" ")
			.map((pair) => pair.split(",").map(Number));
		expect(points?.[1]?.[1]).toBe(0);
	});
});
