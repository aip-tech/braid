import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { extname, join, resolve as resolvePath, sep } from "node:path";
import type { RouteHandler, UpgradeHandler } from "./types.js";

const MIME_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".txt": "text/plain; charset=utf-8",
};

type StaticEntry = { prefix: string; dir: string };

/** Reads `name`'s value out of a raw `Cookie` request header, if present. */
function readCookie(req: IncomingMessage, name: string): string | undefined {
	const header = req.headers.cookie;
	if (!header) return undefined;
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
	}
	return undefined;
}

export type ControlServer = {
	registerRoute(method: string, path: string, handler: RouteHandler): void;
	registerStatic(prefix: string, dir: string): void;
	registerUpgrade(path: string, handler: UpgradeHandler): void;
	listen(): Promise<{ port: number }>;
	close(): Promise<void>;
	readonly token: string;
};

/** A loopback-only HTTP server, bearer-token-guarded on every request. */
export function createControlServer(): ControlServer {
	const token = randomBytes(24).toString("hex");
	const routes = new Map<string, RouteHandler>();
	const staticEntries: StaticEntry[] = [];
	const upgrades = new Map<string, UpgradeHandler>();
	// Set once listen() resolves and the real port is known. Scoped by port (not a bare name)
	// because a browser's cookie jar for "127.0.0.1" isn't port-scoped (RFC 6265 has no port in its
	// scoping) - two braid daemons for two different projects, each on their own ephemeral port,
	// would otherwise silently overwrite each other's cookie.
	let cookieName = "braid_token";

	async function serveStatic(
		entry: StaticEntry,
		pathname: string,
		res: ServerResponse,
	): Promise<void> {
		// Decode before resolving so an encoded traversal payload (%2e%2e%2f) is caught too.
		const relative = decodeURIComponent(pathname.slice(entry.prefix.length));
		const root = resolvePath(entry.dir);
		const filePath = resolvePath(join(root, relative || "index.html"));
		if (filePath !== root && !filePath.startsWith(root + sep)) {
			res.writeHead(403, { "content-type": "text/plain" }).end("Forbidden");
			return;
		}
		if (!existsSync(filePath) || !statSync(filePath).isFile()) {
			res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
			return;
		}
		const contentType =
			MIME_TYPES[extname(filePath)] ?? "application/octet-stream";
		const headers: Record<string, string> = { "content-type": contentType };
		// Belt-and-suspenders for the brief window (before the query-token redirect below fires)
		// where a served HTML page's URL might still carry a `?token=` - an outbound request from
		// that page (an <img>/beacon/external link) shouldn't leak it via Referer.
		if (contentType.startsWith("text/html")) {
			headers["referrer-policy"] = "no-referrer";
		}
		res.writeHead(200, headers);
		createReadStream(filePath).pipe(res);
	}

	async function handleRequest(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		const url = new URL(req.url ?? "/", "http://localhost");
		const method = req.method ?? "GET";

		const headerToken = req.headers.authorization?.startsWith("Bearer ")
			? req.headers.authorization.slice("Bearer ".length)
			: undefined;
		const cookieToken = readCookie(req, cookieName);
		const queryToken = url.searchParams.get("token") ?? undefined;
		const authenticated = headerToken === token || cookieToken === token;
		// Only treated as a *fresh* query-token auth if header/cookie didn't already cover it - a
		// stale `?token=` alongside a valid cookie shouldn't re-trigger the redirect below.
		const viaQueryOnly = !authenticated && queryToken === token;
		if (!authenticated && !viaQueryOnly) {
			res.writeHead(401, { "content-type": "text/plain" }).end("Unauthorized");
			return;
		}

		if (viaQueryOnly) {
			// A plain browser navigation can't send an Authorization header, so a one-time `?token=`
			// (mirroring the upgrade handler's own query-token carve-out below) establishes a session
			// cookie instead - the page's own subsequent fetch()es then authenticate via that cookie
			// without the secret needing to live in every URL.
			res.setHeader(
				"Set-Cookie",
				`${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict`,
			);
			if (method === "GET") {
				// Strip the token from the visible URL/history now that the cookie carries it - the
				// browser re-navigates, this time cookie-authenticated.
				url.searchParams.delete("token");
				res.writeHead(302, { location: `${url.pathname}${url.search}` }).end();
				return;
			}
		}

		const routeHandler = routes.get(`${method} ${url.pathname}`);
		if (routeHandler) {
			try {
				await routeHandler(req, res);
			} catch (error) {
				if (!res.headersSent) {
					res.writeHead(500, { "content-type": "text/plain" });
				}
				res.end(
					`Internal error: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			return;
		}

		const staticEntry = staticEntries.find((entry) =>
			url.pathname.startsWith(entry.prefix),
		);
		if (staticEntry) {
			await serveStatic(staticEntry, url.pathname, res);
			return;
		}

		res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
	}

	const server: Server = createServer((req, res) => {
		void handleRequest(req, res);
	});

	server.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const handler =
			url.searchParams.get("token") === token
				? upgrades.get(url.pathname)
				: undefined;
		if (!handler) {
			socket.destroy();
			return;
		}
		handler(req, socket, head);
	});

	return {
		registerRoute(method, path, handler) {
			const key = `${method.toUpperCase()} ${path}`;
			if (routes.has(key)) {
				throw new Error(`braid: a route is already registered for ${key}`);
			}
			routes.set(key, handler);
		},
		registerStatic(prefix, dir) {
			if (staticEntries.some((entry) => entry.prefix === prefix)) {
				throw new Error(
					`braid: a static handler is already registered for prefix "${prefix}"`,
				);
			}
			staticEntries.push({ prefix, dir });
		},
		registerUpgrade(path, handler) {
			if (upgrades.has(path)) {
				throw new Error(
					`braid: an upgrade handler is already registered for path "${path}"`,
				);
			}
			upgrades.set(path, handler);
		},
		listen() {
			return new Promise((resolve, reject) => {
				server.once("error", reject);
				server.listen(0, "127.0.0.1", () => {
					server.off("error", reject);
					const address = server.address();
					if (address === null || typeof address === "string") {
						reject(new Error("braid: control server failed to bind a port"));
						return;
					}
					cookieName = `braid_token_${address.port}`;
					resolve({ port: address.port });
				});
			});
		},
		close() {
			// server.close() alone waits for idle keep-alive connections too, and can hang forever.
			server.closeIdleConnections();
			return new Promise((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		},
		token,
	};
}
