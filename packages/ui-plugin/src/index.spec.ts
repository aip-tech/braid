import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import type {
	PluginContext,
	PluginLifecycleEvent,
	RouteHandler,
} from "@aip-tech/braid";
import { describe, expect, it, vi } from "vitest";

// Wraps the real readFileSync so getBraidVersion's two fallback tests can override just its next
// call, while every other call (including this file's own comparison read below) still hits disk
// for real.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

import { readFileSync } from "node:fs";
import { getBraidVersion, uiPlugin } from "./index.js";

/** A minimal fake PluginContext - real HTTP/control-server plumbing is already covered by
 *  braid's own tests; this only needs to prove uiPlugin.register() calls the right context
 *  methods with the right values. */
function createFakeContext() {
	const routes = new Map<string, RouteHandler>();
	const listeners = new Map<string, ((event: never) => void)[]>();
	const ctx: PluginContext = {
		registerRoute: vi.fn(
			(method: string, path: string, handler: RouteHandler) => {
				routes.set(`${method} ${path}`, handler);
			},
		),
		registerStatic: vi.fn(),
		registerUpgrade: vi.fn(),
		on: vi.fn((type, handler) => {
			const list = listeners.get(type) ?? [];
			list.push(handler as (event: never) => void);
			listeners.set(type, list);
		}),
		getProcesses: vi.fn(() => []),
		stopProcess: vi.fn(async () => "ok" as const),
		restartProcess: vi.fn(async () => "ok" as const),
		startProcess: vi.fn(async () => "ok" as const),
		log: vi.fn(),
	};
	return {
		ctx,
		routes,
		emit<T extends PluginLifecycleEvent["type"]>(
			type: T,
			event: Extract<PluginLifecycleEvent, { type: T }>,
		) {
			for (const handler of listeners.get(type) ?? [])
				(handler as (event: PluginLifecycleEvent) => void)(event);
		},
	};
}

/** A fake ServerResponse capturing just what a route handler writes, without a real socket. */
function fakeResponse() {
	const res = {
		statusCode: 0,
		headers: {} as Record<string, string>,
		body: "",
		writeHead(status: number, headers?: Record<string, string>) {
			res.statusCode = status;
			Object.assign(res.headers, headers ?? {});
			return res as unknown as ServerResponse;
		},
		end(body?: string) {
			res.body = body ?? "";
			return res as unknown as ServerResponse;
		},
	};
	return res;
}

describe("getBraidVersion", () => {
	it('falls back to "unknown" when the resolved package.json has no version field', () => {
		vi.mocked(readFileSync).mockReturnValueOnce(
			JSON.stringify({ name: "@aip-tech/braid" }),
		);
		expect(getBraidVersion()).toBe("unknown");
	});

	it('falls back to "unknown" when resolving or reading the package.json fails outright', () => {
		vi.mocked(readFileSync).mockImplementationOnce(() => {
			throw new Error("ENOENT");
		});
		expect(getBraidVersion()).toBe("unknown");
	});
});

describe("uiPlugin", () => {
	it('registers static content at the default "/" prefix', () => {
		const { ctx } = createFakeContext();
		uiPlugin.register(ctx, undefined);
		expect(ctx.registerStatic).toHaveBeenCalledWith(
			"/",
			expect.stringMatching(/public$/),
		);
	});

	it("registers static content at a custom prefix when given", () => {
		const { ctx } = createFakeContext();
		uiPlugin.register(ctx, { path: "/dashboard/" });
		expect(ctx.registerStatic).toHaveBeenCalledWith(
			"/dashboard/",
			expect.stringMatching(/public$/),
		);
	});

	it("GET /api/ui/version responds with the installed @aip-tech/braid version", async () => {
		const { ctx, routes } = createFakeContext();
		uiPlugin.register(ctx, undefined);
		const handler = routes.get("GET /api/ui/version");
		expect(handler).toBeDefined();

		const res = fakeResponse();
		await handler?.({} as IncomingMessage, res as unknown as ServerResponse);

		expect(res.statusCode).toBe(200);
		expect(res.headers["content-type"]).toBe("application/json");
		const body = JSON.parse(res.body) as { braidVersion: string };
		// Whatever @aip-tech/braid's own package.json currently declares - not hardcoded, so this
		// doesn't need updating on every braid version bump.
		const braidPkgPath = fileURLToPath(
			import.meta.resolve("@aip-tech/braid/package.json"),
		);
		const braidPkg = JSON.parse(readFileSync(braidPkgPath, "utf8")) as {
			version: string;
		};
		expect(body.braidVersion).toBe(braidPkg.version);
	});

	it("logs the dashboard URL (with prefix and token) once the control server is ready", () => {
		const { ctx, emit } = createFakeContext();
		uiPlugin.register(ctx, { path: "/dash/" });

		emit("controlServerReady", {
			type: "controlServerReady",
			port: 12345,
			token: "secret-token",
		});

		expect(ctx.log).toHaveBeenCalledWith(
			expect.stringContaining(
				"http://127.0.0.1:12345/dash/?token=secret-token",
			),
		);
	});

	it("does not log anything before controlServerReady fires", () => {
		const { ctx } = createFakeContext();
		uiPlugin.register(ctx, undefined);
		expect(ctx.log).not.toHaveBeenCalled();
	});
});
