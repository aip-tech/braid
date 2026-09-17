import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest, Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

		// A token shorter/longer than the real one must be rejected cleanly (not throw) - the
		// constant-time comparison's length check has to handle a mismatch itself.
		const shortAuth = await fetch(`${base}/hello`, {
			headers: { Authorization: "Bearer short" },
		});
		expect(shortAuth.status).toBe(401);
		const longAuth = await fetch(`${base}/hello`, {
			headers: { Authorization: `Bearer ${server.token}-extra-characters` },
		});
		expect(longAuth.status).toBe(401);

		const ok = await fetch(`${base}/hello`, {
			headers: { Authorization: `Bearer ${server.token}` },
		});
		expect(ok.status).toBe(200);
		expect(await ok.text()).toBe("hi");

		await server.close();
	});

	it("returns a generic 500 body for a route handler that throws, without leaking the error message", async () => {
		const server = createControlServer();
		server.registerRoute("GET", "/boom", () => {
			throw new Error("/etc/some-internal-path was not found");
		});
		const { port } = await server.listen();

		const res = await fetch(`http://127.0.0.1:${port}/boom`, {
			headers: { Authorization: `Bearer ${server.token}` },
		});
		expect(res.status).toBe(500);
		const body = await res.text();
		expect(body).not.toContain("/etc/some-internal-path");
		expect(body).toBe("Internal error");

		await server.close();
	});

	it("logs a non-Error thrown value, and an Error without a stack, using their own formatted fallback", async () => {
		const server = createControlServer();
		server.registerRoute("GET", "/string-throw", () => {
			throw "plain string boom";
		});
		server.registerRoute("GET", "/no-stack", () => {
			const err = new Error("no stack here");
			err.stack = undefined;
			throw err;
		});
		const { port } = await server.listen();
		const headers = { Authorization: `Bearer ${server.token}` };
		const writeSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);

		const res1 = await fetch(`http://127.0.0.1:${port}/string-throw`, {
			headers,
		});
		expect(res1.status).toBe(500);
		expect(
			writeSpy.mock.calls.some((call) =>
				String(call[0]).includes("plain string boom"),
			),
		).toBe(true);

		const res2 = await fetch(`http://127.0.0.1:${port}/no-stack`, { headers });
		expect(res2.status).toBe(500);
		expect(
			writeSpy.mock.calls.some((call) =>
				String(call[0]).includes("no stack here"),
			),
		).toBe(true);

		writeSpy.mockRestore();
		await server.close();
	});

	it("doesn't attempt a second writeHead when the handler already sent headers before throwing", async () => {
		const server = createControlServer();
		server.registerRoute("GET", "/mid-stream-throw", (_req, res) => {
			res.writeHead(200, { "content-type": "text/plain" });
			throw new Error("boom mid-response");
		});
		const { port } = await server.listen();
		const writeSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);

		// Headers already went out as 200 by the time the handler throws - the catch block's own
		// `!res.headersSent` guard must skip a second writeHead (which would itself throw "Cannot
		// set headers after they are sent") and still end the response with the generic body.
		const res = await fetch(`http://127.0.0.1:${port}/mid-stream-throw`, {
			headers: { Authorization: `Bearer ${server.token}` },
		});
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("Internal error");

		writeSpy.mockRestore();
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

	it("throws when registering a duplicate upgrade path", () => {
		const server = createControlServer();
		server.registerUpgrade("/ws", () => {});
		expect(() => server.registerUpgrade("/ws", () => {})).toThrow(
			/already registered/,
		);
	});

	it("finds a cookie by name, skipping a malformed segment (no '=') and a non-matching one", async () => {
		const server = createControlServer();
		server.registerRoute("GET", "/hello", (_req, res) => {
			res.end("hi");
		});
		const { port } = await server.listen();

		// Establishes the real cookie name/value via the same query-token dance a browser goes
		// through, then resends it alongside a leading segment with no "=" at all and one whose
		// name doesn't match - both must be skipped over, not mistaken for (or thrown off by).
		const redirected = await fetch(
			`http://127.0.0.1:${port}/hello?token=${server.token}`,
			{ redirect: "manual" },
		);
		const cookiePair = (redirected.headers.get("set-cookie") ?? "").split(
			";",
		)[0];

		const status = await new Promise<number | undefined>((resolve) => {
			const req = httpRequest({
				port,
				host: "127.0.0.1",
				path: "/hello",
				headers: {
					Cookie: `not-a-cookie-pair; other=irrelevant; ${cookiePair}`,
				},
			});
			req.on("response", (res) => {
				resolve(res.statusCode);
				res.resume();
			});
			req.end();
		});
		expect(status).toBe(200);

		await server.close();
	});

	it("401s when a Cookie header is present but none of its entries match the expected name", async () => {
		const server = createControlServer();
		server.registerRoute("GET", "/hello", (_req, res) => {
			res.end("hi");
		});
		const { port } = await server.listen();

		const status = await new Promise<number | undefined>((resolve) => {
			const req = httpRequest({
				port,
				host: "127.0.0.1",
				path: "/hello",
				headers: { Cookie: "unrelated=value; also_unrelated=other" },
			});
			req.on("response", (res) => {
				resolve(res.statusCode);
				res.resume();
			});
			req.end();
		});
		expect(status).toBe(401);

		await server.close();
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

	it("serves index.html for the bare prefix, 404s a missing file, and falls back to octet-stream (no referrer-policy) for an unknown extension", async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "braid-static-"));
		const servedDir = join(tmpDir, "served");
		mkdirSync(servedDir);
		writeFileSync(join(servedDir, "index.html"), "public");
		writeFileSync(join(servedDir, "data.xyz"), "raw bytes");

		const server = createControlServer();
		server.registerStatic("/static/", servedDir);
		const { port } = await server.listen();
		const headers = { Authorization: `Bearer ${server.token}` };

		const bare = await fetch(`http://127.0.0.1:${port}/static/`, { headers });
		expect(bare.status).toBe(200);
		expect(await bare.text()).toBe("public");
		expect(bare.headers.get("referrer-policy")).toBe("no-referrer");

		const missing = await fetch(`http://127.0.0.1:${port}/static/nope.txt`, {
			headers,
		});
		expect(missing.status).toBe(404);

		const unknown = await fetch(`http://127.0.0.1:${port}/static/data.xyz`, {
			headers,
		});
		expect(unknown.status).toBe(200);
		expect(unknown.headers.get("content-type")).toBe(
			"application/octet-stream",
		);
		expect(unknown.headers.get("referrer-policy")).toBeNull();
		// Drain the body - an unconsumed response keeps its connection non-idle, which otherwise
		// makes server.close() below (closeIdleConnections() only clears *idle* ones) wait out the
		// connection's own keep-alive timeout instead of closing promptly.
		await unknown.text();

		await server.close();
	});

	it("prefers the longest matching static prefix regardless of registration order", async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "braid-static-"));
		const rootDir = join(tmpDir, "root");
		const nestedDir = join(tmpDir, "nested");
		mkdirSync(rootDir);
		mkdirSync(nestedDir);
		writeFileSync(join(rootDir, "index.html"), "root content");
		writeFileSync(join(nestedDir, "index.html"), "nested content");

		const server = createControlServer();
		// The broader "/" prefix is registered first (as the UI plugin's default mount would be) -
		// a `.find()` over registration order would let it shadow every path, including one meant
		// for the more specific "/nested/" entry registered after it.
		server.registerStatic("/", rootDir);
		server.registerStatic("/nested/", nestedDir);
		const { port } = await server.listen();
		const headers = { Authorization: `Bearer ${server.token}` };

		const root = await fetch(`http://127.0.0.1:${port}/index.html`, {
			headers,
		});
		expect(await root.text()).toBe("root content");

		const nested = await fetch(`http://127.0.0.1:${port}/nested/index.html`, {
			headers,
		});
		expect(await nested.text()).toBe("nested content");

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

	it("dispatches a raw HTTP upgrade authenticated by the session cookie alone, no query token needed", async () => {
		const server = createControlServer();
		server.registerRoute("GET", "/hello", (_req, res) => {
			res.end("hi");
		});
		server.registerUpgrade("/ws", (_req, socket) => {
			socket.end(
				"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
			);
		});
		const { port } = await server.listen();

		// The same GET ?token= -> Set-Cookie dance a browser navigation goes through.
		const redirected = await fetch(
			`http://127.0.0.1:${port}/hello?token=${server.token}`,
			{ redirect: "manual" },
		);
		const cookie = (redirected.headers.get("set-cookie") ?? "").split(";")[0];
		expect(cookie).toContain(`braid_token_${port}=`);

		const upgraded = await new Promise<boolean>((resolve) => {
			const req = httpRequest({
				port,
				host: "127.0.0.1",
				path: "/ws",
				headers: {
					Connection: "Upgrade",
					Upgrade: "websocket",
					Cookie: cookie,
				},
			});
			req.on("upgrade", () => resolve(true));
			req.on("error", () => resolve(false));
			req.on("close", () => resolve(false));
			req.end();
		});
		expect(upgraded).toBe(true);

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

	it("rejects listen() if the underlying server's own address can't be determined", async () => {
		// server.listen(0, "127.0.0.1", ...) always yields a real AddressInfo in practice - this
		// simulates the defensive fallback for whenever Node's own API contract says otherwise
		// (server.address() is typed to also return null or a string).
		const addressSpy = vi
			.spyOn(Server.prototype, "address")
			.mockReturnValue(null);
		const server = createControlServer();
		try {
			await expect(server.listen()).rejects.toThrow(/failed to bind a port/);
		} finally {
			addressSpy.mockRestore();
			await server.close();
		}
	});

	it("close() propagates an error from the underlying server if it was never listening", async () => {
		const server = createControlServer();
		// Never called listen() - node:http's own server.close() calls back with an error in this
		// case (ERR_SERVER_NOT_RUNNING), which close() here must reject with rather than swallow.
		await expect(server.close()).rejects.toThrow();
	});
});
