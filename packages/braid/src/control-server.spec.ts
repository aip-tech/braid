import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createControlServer } from "./control-server.js";

describe("createControlServer", () => {
	let tmpDir: string;

	afterEach(() => {
		if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
	});

	it("requires the bearer token on every request and dispatches registered routes", async () => {
		const server = createControlServer();
		server.registerRoute("GET", "/hello", (_req, res) => {
			res.writeHead(200, { "content-type": "text/plain" }).end("hi");
		});
		const { port } = await server.listen();
		const base = `http://127.0.0.1:${port}`;

		const noAuth = await fetch(`${base}/hello`);
		expect(noAuth.status).toBe(401);

		const wrongAuth = await fetch(`${base}/hello`, {
			headers: { Authorization: "Bearer wrong" },
		});
		expect(wrongAuth.status).toBe(401);

		const ok = await fetch(`${base}/hello`, {
			headers: { Authorization: `Bearer ${server.token}` },
		});
		expect(ok.status).toBe(200);
		expect(await ok.text()).toBe("hi");

		await server.close();
	});

	it("404s an unregistered path", async () => {
		const server = createControlServer();
		const { port } = await server.listen();
		const res = await fetch(`http://127.0.0.1:${port}/nope`, {
			headers: { Authorization: `Bearer ${server.token}` },
		});
		expect(res.status).toBe(404);
		await server.close();
	});

	it("throws when registering a duplicate route", () => {
		const server = createControlServer();
		server.registerRoute("GET", "/dup", () => {});
		expect(() => server.registerRoute("GET", "/dup", () => {})).toThrow(
			/already registered/,
		);
	});

	it("throws when registering a duplicate static prefix", () => {
		const server = createControlServer();
		server.registerStatic("/static/", "/tmp/one");
		expect(() => server.registerStatic("/static/", "/tmp/two")).toThrow(
			/already registered/,
		);
	});

	it("serves static files under a prefix and blocks path traversal", async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "braid-static-"));
		const servedDir = join(tmpDir, "served");
		writeFileSync(join(tmpDir, "secret.txt"), "secret");
		mkdirSync(servedDir);
		writeFileSync(join(servedDir, "index.html"), "public");

		const server = createControlServer();
		server.registerStatic("/static/", servedDir);
		const { port } = await server.listen();
		const headers = { Authorization: `Bearer ${server.token}` };

		const index = await fetch(`http://127.0.0.1:${port}/static/index.html`, {
			headers,
		});
		expect(index.status).toBe(200);
		expect(await index.text()).toBe("public");

		// Encoded traversal survives URL parsing as literal text, unlike a bare "../".
		const traversal = await fetch(
			`http://127.0.0.1:${port}/static/%2e%2e%2fsecret.txt`,
			{ headers },
		);
		expect(traversal.status).toBe(403);

		await server.close();
	});

	it("dispatches a raw HTTP upgrade to a registered path, guarded by a query-string token", async () => {
		const server = createControlServer();
		server.registerUpgrade("/ws", (_req, socket) => {
			socket.end(
				"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
			);
		});
		const { port } = await server.listen();

		const upgraded = await new Promise<boolean>((resolve) => {
			const req = httpRequest({
				port,
				host: "127.0.0.1",
				path: `/ws?token=${server.token}`,
				headers: { Connection: "Upgrade", Upgrade: "websocket" },
			});
			req.on("upgrade", () => resolve(true));
			req.on("error", () => resolve(false));
			req.on("close", () => resolve(false));
			req.end();
		});
		expect(upgraded).toBe(true);

		const rejected = await new Promise<boolean>((resolve) => {
			const req = httpRequest({
				port,
				host: "127.0.0.1",
				path: "/ws?token=wrong",
				headers: { Connection: "Upgrade", Upgrade: "websocket" },
			});
			// Both an error and a clean close count as "rejected" here.
			req.on("upgrade", () => resolve(false));
			req.on("error", () => resolve(true));
			req.on("close", () => resolve(true));
			req.end();
		});
		expect(rejected).toBe(true);

		await server.close();
	});

	it("close() resolves promptly even after keep-alive fetch() connections", async () => {
		const server = createControlServer();
		server.registerRoute("GET", "/ping", (_req, res) => {
			res.end("pong");
		});
		const { port } = await server.listen();
		const headers = { Authorization: `Bearer ${server.token}` };
		await fetch(`http://127.0.0.1:${port}/ping`, { headers });
		await fetch(`http://127.0.0.1:${port}/ping`, { headers });
		await server.close();
	}, 5000);

	it("authenticates a GET via ?token=, sets a port-scoped cookie, and redirects stripping it", async () => {
		const server = createControlServer();
		server.registerRoute("GET", "/hello", (_req, res) => {
			res.writeHead(200, { "content-type": "text/plain" }).end("hi");
		});
		const { port } = await server.listen();
		const base = `http://127.0.0.1:${port}`;

		const redirected = await fetch(`${base}/hello?token=${server.token}`, {
			redirect: "manual",
		});
		expect(redirected.status).toBe(302);
		expect(redirected.headers.get("location")).toBe("/hello");
		const cookie = redirected.headers.get("set-cookie") ?? "";
		expect(cookie).toContain(`braid_token_${port}=${server.token}`);
		expect(cookie).toContain("HttpOnly");

		// The cookie alone (no Authorization header, no query token) now authenticates.
		const cookieValue = cookie.split(";")[0];
		const viaCookie = await fetch(`${base}/hello`, {
			headers: { Cookie: cookieValue },
		});
		expect(viaCookie.status).toBe(200);
		expect(await viaCookie.text()).toBe("hi");

		await server.close();
	});

	it("rejects a bad ?token= the same as a missing one, and doesn't redirect a POST", async () => {
		const server = createControlServer();
		server.registerRoute("POST", "/action", (_req, res) => {
			res.end("done");
		});
		const { port } = await server.listen();
		const base = `http://127.0.0.1:${port}`;

		const bad = await fetch(`${base}/action?token=wrong`, { method: "POST" });
		expect(bad.status).toBe(401);

		const good = await fetch(`${base}/action?token=${server.token}`, {
			method: "POST",
		});
		expect(good.status).toBe(200);
		expect(await good.text()).toBe("done");

		await server.close();
	});

	it("scopes the auth cookie by port, so two servers don't collide", async () => {
		const serverA = createControlServer();
		const serverB = createControlServer();
		serverA.registerRoute("GET", "/hello", (_req, res) => {
			res.end("a");
		});
		serverB.registerRoute("GET", "/hello", (_req, res) => {
			res.end("b");
		});
		const { port: portA } = await serverA.listen();
		const { port: portB } = await serverB.listen();

		const cookieA = (
			await fetch(`http://127.0.0.1:${portA}/hello?token=${serverA.token}`, {
				redirect: "manual",
			})
		).headers.get("set-cookie");
		const cookieB = (
			await fetch(`http://127.0.0.1:${portB}/hello?token=${serverB.token}`, {
				redirect: "manual",
			})
		).headers.get("set-cookie");

		expect(cookieA).toContain(`braid_token_${portA}=`);
		expect(cookieB).toContain(`braid_token_${portB}=`);
		expect(cookieA).not.toBe(cookieB);

		await serverA.close();
		await serverB.close();
	});
});
