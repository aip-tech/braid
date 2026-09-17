// @vitest-environment jsdom
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BackIcon, StopIcon } from "./icons.js";

let container: HTMLDivElement;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
});

afterEach(() => {
	act(() => render(null, container));
	container.remove();
});

describe("icons", () => {
	it("renders with the base 'icon' class when none is given", () => {
		act(() => render(<BackIcon />, container));
		expect(container.querySelector("svg")?.getAttribute("class")).toBe("icon");
	});

	it("appends a given class alongside the base 'icon' class", () => {
		act(() => render(<StopIcon class="btn-danger-icon" />, container));
		expect(container.querySelector("svg")?.getAttribute("class")).toBe(
			"icon btn-danger-icon",
		);
	});
});
