// @vitest-environment jsdom
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogControllerCallbacks } from "./log-controller.js";

// LogPane is a thin wrapper around LogController (real fetch/DOM/streaming logic, covered on its
// own in log-controller.spec.ts) - mocking the class here lets these tests verify just LogPane's
// own wiring (construction, start()/destroy() lifecycle, and rendering off the two callbacks) in
// isolation, by driving those callbacks directly instead of needing a real log stream.
type FakeController = {
	logEl: HTMLDivElement;
	logInnerEl: HTMLDivElement;
	callbacks: LogControllerCallbacks;
	start: ReturnType<typeof vi.fn>;
	destroy: ReturnType<typeof vi.fn>;
	loadOlder: ReturnType<typeof vi.fn>;
};
const instances: FakeController[] = [];

vi.mock("./log-controller.js", () => ({
	LogController: class {
		logEl: HTMLDivElement;
		logInnerEl: HTMLDivElement;
		callbacks: LogControllerCallbacks;
		start = vi.fn();
		destroy = vi.fn();
		loadOlder = vi.fn();

		constructor(
			logEl: HTMLDivElement,
			logInnerEl: HTMLDivElement,
			callbacks: LogControllerCallbacks,
		) {
			this.logEl = logEl;
			this.logInnerEl = logInnerEl;
			this.callbacks = callbacks;
			instances.push(this as unknown as FakeController);
		}
	},
}));

import { LogPane } from "./log-pane.js";

let container: HTMLDivElement;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	instances.length = 0;
});

afterEach(() => {
	act(() => render(null, container));
	container.remove();
});

describe("LogPane", () => {
	it("creates one LogController on mount and starts it with the given name", () => {
		act(() => render(<LogPane name="api" />, container));
		expect(instances).toHaveLength(1);
		expect(instances[0].start).toHaveBeenCalledWith("api");
	});

	it("destroys the controller on unmount", () => {
		act(() => render(<LogPane name="api" />, container));
		const controller = instances[0];
		act(() => render(null, container));
		expect(controller.destroy).toHaveBeenCalledTimes(1);
	});

	it("re-starts the same controller (not a new one) when the name prop changes", () => {
		act(() => render(<LogPane name="api" />, container));
		act(() => render(<LogPane name="worker" />, container));

		expect(instances).toHaveLength(1);
		expect(instances[0].start).toHaveBeenNthCalledWith(1, "api");
		expect(instances[0].start).toHaveBeenNthCalledWith(2, "worker");
	});

	it("shows the status line only once onStatusChange reports a message", () => {
		act(() => render(<LogPane name="api" />, container));
		expect(container.querySelector(".error")).toHaveProperty("hidden", true);

		act(() => instances[0].callbacks.onStatusChange("Reconnecting..."));

		const errorEl = container.querySelector(".error");
		expect(errorEl).toHaveProperty("hidden", false);
		expect(errorEl?.textContent).toBe("Reconnecting...");
	});

	it("shows the Load older button once available, and calls loadOlder() on click", () => {
		act(() => render(<LogPane name="api" />, container));
		act(() =>
			instances[0].callbacks.onLoadOlderStateChange({
				hidden: false,
				loading: false,
			}),
		);

		const button = container.querySelector<HTMLButtonElement>(".load-older");
		expect(button?.hidden).toBe(false);
		expect(button?.disabled).toBe(false);
		expect(button?.textContent).toContain("Load older lines");

		act(() => button?.click());
		expect(instances[0].loadOlder).toHaveBeenCalledTimes(1);
	});

	it("shows 'Loading...' and disables the button while a page is loading", () => {
		act(() => render(<LogPane name="api" />, container));
		act(() =>
			instances[0].callbacks.onLoadOlderStateChange({
				hidden: false,
				loading: true,
			}),
		);

		const button = container.querySelector<HTMLButtonElement>(".load-older");
		expect(button?.disabled).toBe(true);
		expect(button?.textContent).toContain("Loading...");
	});
});
