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

export type ControlServer = {
	registerRoute(method: string, path: string, handler: RouteHandler): void;
	registerStatic(prefix: string, dir: string): void;
	registerUpgrade(path: string, handler: UpgradeHandler): void;
	listen(): Promise<{ port: number }>;
	close(): Promise<void>;
	readonly token: string;
};

/**
 * A loopback-only HTTP server, bearer-token-guarded on every request, that
 * both braid's own core plugins and external plugins register routes/static
 * dirs/upgrade handlers on through the exact same three methods - there is
 * deliberately no separate internal registration path.
 */
export function createControlServer(): ControlServer {
	const token = randomBytes(24).toString("hex");
	const routes = new Map<string, RouteHandler>();
	const staticEntries: StaticEntry[] = [];
	const upgrades = new Map<string, UpgradeHandler>();

	async function serveStatic(
		entry: StaticEntry,
		pathname: string,
		res: ServerResponse,
	): Promise<void> {
		// decodeURIComponent before resolving so an encoded traversal payload
		// (%2e%2e%2f) is caught by the same startsWith(root) check as a literal one.
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
		res.writeHead(200, { "content-type": contentType });
		createReadStream(filePath).pipe(res);
	}

	async function handleRequest(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (req.headers.authorization !== `Bearer ${token}`) {
			res.writeHead(401, { "content-type": "text/plain" }).end("Unauthorized");
			return;
		}

		const routeHandler = routes.get(`${req.method ?? "GET"} ${url.pathname}`);
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
					resolve({ port: address.port });
				});
			});
		},
		close() {
			// Plain server.close() waits for every open connection, including idle
			// keep-alive sockets a pooling client (e.g. fetch()) leaves open, and
			// can hang indefinitely - closeIdleConnections() clears those first.
			server.closeIdleConnections();
			return new Promise((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		},
		token,
	};
}
