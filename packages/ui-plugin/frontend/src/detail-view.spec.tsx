// @vitest-environment jsdom
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessStatus } from "./api.js";
import { DetailView } from "./detail-view.js";

function makeProcess(overrides: Partial<ProcessStatus> = {}): ProcessStatus {
	return {
		name: "api",
		pid: 111,
		alive: true,
		startedAt: new Date(0).toISOString(),
		cpu: 1.2,
		memory: 2 * 1024 * 1024,
		...overrides,
	};
}

let container: HTMLDivElement;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	// DetailView always mounts a LogPane (-> a real LogController), which fetches
	// /api/logs/history and /api/logs?follow=true on mount - not what this file is testing, and
	// LogController already handles a failing/malformed response gracefully on its own, so a
	// blanket 404 here just keeps these tests from making a real network call.
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				({
					ok: false,
					status: 404,
					json: async () => ({}),
					text: async () => "",
				}) as Response,
		),
	);
});

afterEach(() => {
	act(() => render(null, container));
	container.remove();
	vi.unstubAllGlobals();
});

describe("DetailView", () => {
	it('shows "not started" and only a Start button for a process that has never run', () => {
		act(() =>
			render(
				<DetailView
					name="cron"
					process={makeProcess({
						name: "cron",
						alive: false,
						startedAt: undefined,
						pid: undefined,
					})}
					statusLoaded={true}
					history={[]}
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

	it('shows "unknown" before status has ever loaded, and "-" for pid/started, for an unknown process', () => {
		act(() =>
			render(
				<DetailView
					name="ghost"
					process={undefined}
					statusLoaded={true}
					history={[]}
					pending={new Set()}
					rowErrors={new Map()}
					onAction={() => {}}
				/>,
				container,
			),
		);

		expect(container.querySelector(".badge-status")?.textContent).toBe(
			"unknown",
		);
		expect(container.querySelector(".badge-pid")?.textContent).toBe("-");
	});

	it('shows a blank status badge instead of "unknown" while the first status fetch is still in flight', () => {
		act(() =>
			render(
				<DetailView
					name="ghost"
					process={undefined}
					statusLoaded={false}
					history={[]}
					pending={new Set()}
					rowErrors={new Map()}
					onAction={() => {}}
				/>,
				container,
			),
		);

		expect(container.querySelector(".badge-status")?.textContent).toBe("");
	});

	it("hides the CPU/memory charts until there are at least two history samples", () => {
		act(() =>
			render(
				<DetailView
					name="api"
					process={makeProcess()}
					statusLoaded={true}
					history={[{ cpu: 1, memory: 1024 }]}
					pending={new Set()}
					rowErrors={new Map()}
					onAction={() => {}}
				/>,
				container,
			),
		);
		expect(container.querySelector(".charts")).toBeNull();

		act(() =>
			render(
				<DetailView
					name="api"
					process={makeProcess()}
					statusLoaded={true}
					history={[
						{ cpu: 1, memory: 1024 },
						{ cpu: 2, memory: 2048 },
					]}
					pending={new Set()}
					rowErrors={new Map()}
					onAction={() => {}}
				/>,
				container,
			),
		);
		expect(container.querySelector(".charts")).not.toBeNull();
		expect(container.querySelector(".chart-value")?.textContent).toBe(
			formattedLastCpu(),
		);
	});

	it("calls onAction with the process's own name (not the row's) when a button is clicked", () => {
		const onAction = vi.fn();
		act(() =>
			render(
				<DetailView
					name="api"
					process={makeProcess({ name: "api", alive: true })}
					statusLoaded={true}
					history={[]}
					pending={new Set()}
					rowErrors={new Map()}
					onAction={onAction}
				/>,
				container,
			),
		);

		act(() => container.querySelector<HTMLButtonElement>(".btn-stop")?.click());

		expect(onAction).toHaveBeenCalledWith("stop", "api");
	});
});

function formattedLastCpu(): string {
	return "2.0%";
}
