import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { request as httpRequest, Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createControlServer,
	decodeStaticPath,
	parseRequestUrl,
} from "./control-server.js";

/** Sends `raw` bytes straight down a TCP socket and resolves with everything the server sent back
 *  before closing it - for requests fetch() itself refuses to construct (a malformed target). */
function rawRequest(port: number, raw: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = connect(port, "127.0.0.1", () => socket.write(raw));
		let data = "";
		socket.on("data", (chunk) => {
			data += chunk.toString();
		});
		socket.on("end", () => resolve(data));
		socket.on("error", reject);
	});
}

/** Opens a raw upgrade request against `path`, resolving once the server closes or errors it. */
function upgradeRequest(
	port: number,
	path: string,
	onSocketReady?: (req: ReturnType<typeof httpRequest>) => void,
): Promise<"upgraded" | "closed"> {
	return new Promise((resolve) => {
		const req = httpRequest({
			port,
			host: "127.0.0.1",
			path,
			headers: { Connection: "Upgrade", Upgrade: "websocket" },
		});
		req.on("upgrade", () => resolve("upgraded"));
		req.on("error", () => resolve("closed"));
		req.on("close", () => resolve("closed"));
		req.end();
		onSocketReady?.(req);
	});
}

describe("parseRequestUrl", () => {
	it("parses an origin-form target against a localhost base", () => {
		expect(parseRequestUrl("/a?b=1")?.pathname).toBe("/a");
		expect(parseRequestUrl(undefined)?.pathname).toBe("/");
	});

	it("returns undefined instead of throwing for a target URL rejects", () => {
		expect(parseRequestUrl("http://[")).toBeUndefined();
	});
});

describe("decodeStaticPath", () => {
	it("decodes valid percent-encoding", () => {
		expect(decodeStaticPath("a%20b")).toBe("a b");
	});

	it("returns undefined instead of throwing for malformed percent-encoding", () => {
		expect(decodeStaticPath("%E0%A4%A")).toBeUndefined();
	});
});

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

		// Headers already went out as 200 by the time the handler throws - a second writeHead would
		// itself throw, and appending "Internal error" would corrupt a body the client can't tell
		// apart from a real one, so the connection is cut instead.
		// (writeHead alone is still buffered, so the client sees the connection close rather than
		// even a status line.)
		await expect(
			fetch(`http://127.0.0.1:${port}/mid-stream-throw`, {
				headers: { Authorization: `Bearer ${server.token}` },
			}).then((res) => res.text()),
		).rejects.toThrow();

		// ...and the server itself is still up afterwards.
		const after = await fetch(`http://127.0.0.1:${port}/missing`, {
			headers: { Authorization: `Bearer ${server.token}` },
		});
		expect(after.status).toBe(404);

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
	it("400s a malformed request target before auth, and keeps serving afterwards", async () => {
		const server = createControlServer();
		const { port } = await server.listen();

		const response = await rawRequest(
			port,
			`GET http://[ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
		);
		expect(response.startsWith("HTTP/1.1 400")).toBe(true);

		const after = await fetch(`http://127.0.0.1:${port}/missing`, {
			headers: { Authorization: `Bearer ${server.token}` },
		});
		expect(after.status).toBe(404);
		await server.close();
	});

	it("400s malformed percent-encoding under a static prefix instead of crashing", async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "braid-static-"));
		writeFileSync(join(tmpDir, "index.html"), "public");
		const server = createControlServer();
		server.registerStatic("/static/", tmpDir);
		const { port } = await server.listen();
		const headers = { Authorization: `Bearer ${server.token}` };

		const bad = await fetch(`http://127.0.0.1:${port}/static/%E0%A4%A`, {
			headers,
		});
		expect(bad.status).toBe(400);
		const good = await fetch(`http://127.0.0.1:${port}/static/index.html`, {
			headers,
		});
		expect(good.status).toBe(200);
		await server.close();
	});

	it.skipIf(process.getuid?.() === 0)(
		"cuts the connection (without crashing) when a static file can't be read after its stat",
		async () => {
			tmpDir = mkdtempSync(join(tmpdir(), "braid-static-"));
			const file = join(tmpDir, "locked.txt");
			writeFileSync(file, "secret");
			// Passes existsSync/statSync, then fails at open - the same shape as a file removed
			// between the stat and the read.
			chmodSync(file, 0o000);
			const server = createControlServer();
			server.registerStatic("/static/", tmpDir);
			const { port } = await server.listen();
			const headers = { Authorization: `Bearer ${server.token}` };

			await expect(
				fetch(`http://127.0.0.1:${port}/static/locked.txt`, {
					headers,
				}).then((res) => res.text()),
			).rejects.toThrow();

			const after = await fetch(`http://127.0.0.1:${port}/missing`, {
				headers,
			});
			expect(after.status).toBe(404);
			chmodSync(file, 0o600);
			await server.close();
		},
	);

	it("ends a response with a 500 when the request handling itself rejects unexpectedly", async () => {
		const server = createControlServer();
		server.registerStatic("/static/", "/nonexistent-root");
		const { port } = await server.listen();
		const writeSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		// The longest-prefix lookup calls startsWith on each entry's prefix - forcing that to throw
		// stands in for any bug outside a route handler's own try/catch.
		const startsWith = vi
			.spyOn(String.prototype, "startsWith")
			.mockImplementationOnce(() => {
				throw new Error("unexpected");
			});

		const res = await fetch(`http://127.0.0.1:${port}/static/x`, {
			headers: { Authorization: `Bearer ${server.token}` },
		});
		startsWith.mockRestore();
		expect(res.status).toBe(500);
		expect(await res.text()).toBe("Internal error");
		expect(
			writeSpy.mock.calls.some(([line]) =>
				String(line).includes(
					"request GET /static/x failed: Error: unexpected",
				),
			),
		).toBe(true);

		writeSpy.mockRestore();
		await server.close();
	});

	it("destroys the socket for a malformed upgrade target, and survives upgrade handlers that throw or reject", async () => {
		const server = createControlServer();
		server.registerUpgrade("/sync-throw", () => {
			throw new Error("sync boom");
		});
		server.registerUpgrade("/async-throw", async () => {
			throw new Error("async boom");
		});
		const { port } = await server.listen();
		const writeSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);

		const malformed = await rawRequest(
			port,
			`GET http://[ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
		);
		expect(malformed).toBe("");
		expect(
			await upgradeRequest(port, `/sync-throw?token=${server.token}`),
		).toBe("closed");
		expect(
			await upgradeRequest(port, `/async-throw?token=${server.token}`),
		).toBe("closed");
		for (const message of ["sync boom", "async boom"]) {
			expect(
				writeSpy.mock.calls.some(([line]) => String(line).includes(message)),
			).toBe(true);
		}

		const after = await fetch(`http://127.0.0.1:${port}/missing`, {
			headers: { Authorization: `Bearer ${server.token}` },
		});
		expect(after.status).toBe(404);
		writeSpy.mockRestore();
		await server.close();
	});

	it("survives a client resetting an upgraded socket", async () => {
		const server = createControlServer();
		let serverSocketClosed!: () => void;
		const closed = new Promise<void>((resolve) => {
			serverSocketClosed = resolve;
		});
		// Holds the socket open without replying, the way a real WebSocket handler would.
		server.registerUpgrade("/hold", (_req, socket) => {
			socket.on("close", () => serverSocketClosed());
		});
		const { port } = await server.listen();

		const socket = connect(port, "127.0.0.1", () => {
			socket.write(
				`GET /hold?token=${server.token} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
			);
			// Give the server a moment to dispatch the upgrade, then reset (RST, not FIN).
			setTimeout(() => socket.resetAndDestroy(), 100);
		});
		socket.on("error", () => {});
		await closed;

		const after = await fetch(`http://127.0.0.1:${port}/missing`, {
			headers: { Authorization: `Bearer ${server.token}` },
		});
		expect(after.status).toBe(404);
		await server.close();
	});
});
