// @vitest-environment jsdom
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessStatus } from "./api.js";
import { TableView } from "./table-view.js";

function makeProcess(overrides: Partial<ProcessStatus> = {}): ProcessStatus {
	return {
		name: "api",
		pid: 111,
		alive: true,
		startedAt: new Date(0).toISOString(),
		cpu: 1.2,
		memory: 2 * 1024 * 1024,
		restartCount: 0,
		...overrides,
	};
}

let container: HTMLDivElement;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
});

afterEach(() => {
	act(() => render(null, container));
	container.remove();
});

describe("TableView", () => {
	it("sorts rows by name regardless of input order", () => {
		act(() =>
			render(
				<TableView
					processes={[
						makeProcess({ name: "worker" }),
						makeProcess({ name: "api" }),
						makeProcess({ name: "client" }),
					]}
					pending={new Set()}
					rowErrors={new Map()}
					onAction={() => {}}
				/>,
				container,
			),
		);

		const names = [...container.querySelectorAll("#processes tbody tr a")].map(
			(a) => a.textContent,
		);
		expect(names).toEqual(["api", "client", "worker"]);
	});

	it('shows only a Start button for a never-started process ("autoStart: false", not yet run)', () => {
		act(() =>
			render(
				<TableView
					processes={[
						makeProcess({ alive: false, startedAt: undefined, pid: undefined }),
					]}
					pending={new Set()}
					rowErrors={new Map()}
					onAction={() => {}}
				/>,
				container,
			),
		);

		expect(container.querySelector(".badge-status")?.textContent).toBe(
			"not started",
		);
		expect(container.querySelector(".btn-stop")).toBeNull();
		expect(container.querySelector(".btn-restart")?.textContent).toContain(
			"Start",
		);
	});

	it("shows Stop (enabled) and Restart for a running process that has started before", () => {
		act(() =>
			render(
				<TableView
					processes={[makeProcess({ alive: true })]}
					pending={new Set()}
					rowErrors={new Map()}
					onAction={() => {}}
				/>,
				container,
			),
		);

		expect(container.querySelector(".badge-status")?.textContent).toBe(
			"running",
		);
		const stopButton = container.querySelector<HTMLButtonElement>(".btn-stop");
		expect(stopButton?.disabled).toBe(false);
		expect(stopButton?.textContent).toContain("Stop");
	});

	it('shows a disabled Stop button and "stopped" status for a process that ran before but exited', () => {
		act(() =>
			render(
				<TableView
					processes={[makeProcess({ alive: false })]}
					pending={new Set()}
					rowErrors={new Map()}
					onAction={() => {}}
				/>,
				container,
			),
		);

		expect(container.querySelector(".badge-status")?.textContent).toBe(
			"stopped",
		);
		expect(
			container.querySelector<HTMLButtonElement>(".btn-stop")?.disabled,
		).toBe(true);
	});

	it("disables every action button for a process with a pending request, and shows its row error", () => {
		act(() =>
			render(
				<TableView
					processes={[makeProcess({ name: "api", alive: true })]}
					pending={new Set(["api"])}
					rowErrors={new Map([["api", "couldn't reach braid"]])}
					onAction={() => {}}
				/>,
				container,
			),
		);

		expect(
			container.querySelector<HTMLButtonElement>(".btn-stop")?.disabled,
		).toBe(true);
		expect(
			container.querySelector<HTMLButtonElement>(".btn-restart")?.disabled,
		).toBe(true);
		expect(container.querySelector(".row-error")?.textContent).toBe(
			"couldn't reach braid",
		);
	});

	it("shows an em-dash for cpu/memory while neither has been sampled yet", () => {
		act(() =>
			render(
				<TableView
					processes={[makeProcess({ cpu: undefined, memory: undefined })]}
					pending={new Set()}
					rowErrors={new Map()}
					onAction={() => {}}
				/>,
				container,
			),
		);

		const statCells = container.querySelectorAll(".stat-cell");
		expect(statCells[0]?.textContent).toBe("–");
		expect(statCells[1]?.textContent).toBe("–");
	});

	it("calls onAction with start when the Start button is clicked for a never-started process", () => {
		const onAction = vi.fn();
		act(() =>
			render(
				<TableView
					processes={[
						makeProcess({
							name: "cron",
							alive: false,
							startedAt: undefined,
							pid: undefined,
						}),
					]}
					pending={new Set()}
					rowErrors={new Map()}
					onAction={onAction}
				/>,
				container,
			),
		);

		act(() =>
			container.querySelector<HTMLButtonElement>(".btn-restart")?.click(),
		);

		expect(onAction).toHaveBeenCalledWith("start", "cron");
	});

	it("shows '...' on the Start button while a start action is pending for a never-started process", () => {
		act(() =>
			render(
				<TableView
					processes={[
						makeProcess({
							name: "cron",
							alive: false,
							startedAt: undefined,
							pid: undefined,
						}),
					]}
					pending={new Set(["cron"])}
					rowErrors={new Map()}
					onAction={() => {}}
				/>,
				container,
			),
		);

		expect(container.querySelector(".btn-restart")?.textContent).toContain(
			"...",
		);
	});

	it("shows the restart count, and an em-dash for uptime while stopped", () => {
		act(() =>
			render(
				<TableView
					processes={[makeProcess({ alive: false, restartCount: 3 })]}
					pending={new Set()}
					rowErrors={new Map()}
					onAction={() => {}}
				/>,
				container,
			),
		);

		const statCells = container.querySelectorAll(".stat-cell");
		expect(statCells[2]?.textContent).toBe("3");
		expect(statCells[3]?.textContent).toBe("–");
	});

	it("shows a formatted uptime for a running process", () => {
		act(() =>
			render(
				<TableView
					processes={[
						makeProcess({
							alive: true,
							startedAt: new Date(Date.now() - 5000).toISOString(),
						}),
					]}
					pending={new Set()}
					rowErrors={new Map()}
					onAction={() => {}}
				/>,
				container,
			),
		);

		const statCells = container.querySelectorAll(".stat-cell");
		expect(statCells[3]?.textContent).toMatch(/^\ds$/);
	});

	it("shows an em-dash for restarts (not undefined/0) when talking to a pre-0.9.5 daemon that doesn't send it", () => {
		act(() =>
			render(
				<TableView
					processes={[makeProcess({ restartCount: undefined })]}
					pending={new Set()}
					rowErrors={new Map()}
					onAction={() => {}}
				/>,
				container,
			),
		);

		const statCells = container.querySelectorAll(".stat-cell");
		expect(statCells[2]?.textContent).toBe("–");
	});

	it("calls onAction with the action and process name when a button is clicked", () => {
		const onAction = vi.fn();
		act(() =>
			render(
				<TableView
					processes={[makeProcess({ name: "api", alive: true })]}
					pending={new Set()}
					rowErrors={new Map()}
					onAction={onAction}
				/>,
				container,
			),
		);

		act(() =>
			container.querySelector<HTMLButtonElement>(".btn-restart")?.click(),
		);

		expect(onAction).toHaveBeenCalledWith("restart", "api");
	});
});
