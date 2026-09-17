// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const renderMock = vi.fn();
vi.mock("preact", () => ({ render: renderMock }));

describe("main", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("renders <App /> into the #root element", async () => {
		const root = document.createElement("div");
		root.id = "root";
		document.body.appendChild(root);

		await import("./main.js");

		expect(renderMock).toHaveBeenCalledTimes(1);
		const [, target] = renderMock.mock.calls[0];
		expect(target).toBe(root);
	});
});
