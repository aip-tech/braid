import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import {
	createServer,
	type IncomingHttpHeaders,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { extname, join, resolve as resolvePath, sep } from "node:path";
import { braidTag } from "./prefix.js";
import type { RouteHandler, UpgradeHandler } from "./types.js";

/**
 * Constant-time string comparison - a bearer/cookie/query token check against `a === b` would
 * short-circuit on the first mismatched byte, letting a local attacker who can send enough timed
 * requests recover the secret one byte at a time from response-timing differences.
 */
function safeEqual(a: string, b: string): boolean {
	const bufA = Buffer.from(a);
	const bufB = Buffer.from(b);
	return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

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

/**
 * Parses a raw request target, returning undefined (rather than throwing) for one `new URL` rejects
 * - e.g. an absolute-form target like `http://[` - so a single malformed request gets a 400 instead
 * of an uncaught TypeError taking the whole daemon down. Not `URL.parse()`: that needs Node 22.1+,
 * and `engines` allows any 22.x.
 */
export function parseRequestUrl(raw: string | undefined): URL | undefined {
	try {
		return new URL(raw ?? "/", "http://localhost");
	} catch {
		return undefined;
	}
}

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Lower-cased `host[:port]` of a Host header value, or undefined if it isn't a valid one. */
function normalizeHost(host: string): string | undefined {
	try {
		return new URL(`http://${host}`).host;
	} catch {
		return undefined;
	}
}

/**
 * Whether a request's Host header names this machine's loopback interface. The server only listens
 * on 127.0.0.1, so any other name means DNS rebinding: a hostile page whose own domain has been
 * re-pointed at 127.0.0.1. Only the hostname is checked, not the port - through an SSH tunnel or a
 * devcontainer port forward, the browser legitimately sees (and sends) a different port.
 */
export function isLoopbackHost(host: string | undefined): boolean {
	if (!host) return false;
	const normalized = normalizeHost(host);
	if (normalized === undefined) return false;
	return LOOPBACK_HOSTNAMES.has(new URL(`http://${normalized}`).hostname);
}

/**
 * Whether a request comes from the page this server itself served, rather than a cross-site one a
 * browser sent on another page's behalf. Applied to every request that can change something (any
 * non-GET/HEAD, and upgrades): browsers always send Origin on those when they're cross-origin -
 * including from another port on 127.0.0.1, which counts as the same *site* (so SameSite cookies
 * still go along) but never the same origin. A request with no Origin at all comes from a non-browser
 * client (the CLI, curl) and is allowed. The Origin is compared with the request's own Host header
 * rather than a fixed port, so it still matches through a port forward.
 */
export function isSameOriginRequest(headers: IncomingHttpHeaders): boolean {
	const site = headers["sec-fetch-site"];
	if (site !== undefined && site !== "same-origin" && site !== "none") {
		return false;
	}
	const origin = headers.origin;
	if (origin === undefined) return true;
	try {
		return (
			headers.host !== undefined &&
			new URL(origin).host === normalizeHost(headers.host)
		);
	} catch {
		// Includes the literal "null" a sandboxed or opaque origin sends.
		return false;
	}
}

/** `decodeURIComponent`, but undefined (not a thrown URIError) for malformed percent-encoding. */
export function decodeStaticPath(encoded: string): string | undefined {
	try {
		return decodeURIComponent(encoded);
	} catch {
		return undefined;
	}
}

/** Ends a response whose handling threw: a generic 500 if nothing has been sent yet, otherwise
 *  the connection is cut - once headers are out, appending "Internal error" would just corrupt a
 *  200 body the client can't tell apart from a real one. */
function failResponse(res: ServerResponse): void {
	if (res.headersSent) {
		res.destroy();
	} else {
		res.writeHead(500, { "content-type": "text/plain" }).end("Internal error");
	}
}

function describeError(error: unknown): string {
	return error instanceof Error
		? (error.stack ?? error.message)
		: String(error);
}

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
		const relative = decodeStaticPath(pathname.slice(entry.prefix.length));
		if (relative === undefined) {
			res.writeHead(400, { "content-type": "text/plain" }).end("Bad request");
			return;
		}
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
		// The 200 is already on the wire by the time an open/read error (a file removed or made
		// unreadable after the stat above) can surface, so cutting the connection is the only honest
		// signal left - and without a listener the error would be uncaught, killing the daemon.
		createReadStream(filePath)
			.on("error", () => res.destroy())
			.pipe(res);
	}

	async function handleRequest(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		const url = parseRequestUrl(req.url);
		if (!url) {
			res.writeHead(400, { "content-type": "text/plain" }).end("Bad request");
			return;
		}
		// `?? "GET"` satisfies IncomingMessage's own optional typing - in practice, Node's HTTP
		// parser never emits a 'request' event without it already set, so there's no way to exercise
		// this fallback from a real request without bypassing the parser entirely.
		// istanbul ignore next
		const method = req.method ?? "GET";
		// Both checked before auth, so a rejected request learns nothing about the token.
		if (!isLoopbackHost(req.headers.host)) {
			res
				.writeHead(421, { "content-type": "text/plain" })
				.end("Misdirected request");
			return;
		}
		if (
			method !== "GET" &&
			method !== "HEAD" &&
			!isSameOriginRequest(req.headers)
		) {
			res.writeHead(403, { "content-type": "text/plain" }).end("Forbidden");
			return;
		}

		const headerToken = req.headers.authorization?.startsWith("Bearer ")
			? req.headers.authorization.slice("Bearer ".length)
			: undefined;
		const cookieToken = readCookie(req, cookieName);
		const queryToken = url.searchParams.get("token") ?? undefined;
		const authenticated =
			safeEqual(headerToken ?? "", token) ||
			safeEqual(cookieToken ?? "", token);
		// Only treated as a *fresh* query-token auth if header/cookie didn't already cover it - a
		// stale `?token=` alongside a valid cookie shouldn't re-trigger the redirect below.
		const viaQueryOnly = !authenticated && safeEqual(queryToken ?? "", token);
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
				// Logged here (not echoed to the client below) - anyone holding the token can reach
				// this, and the token itself isn't the only thing that can leak (a shared machine, a
				// stale world-readable pidfile from before that was fixed), so route handler internals
				// (file paths, module names) shouldn't ride along in the response body too.
				process.stderr.write(
					`${braidTag()} route handler for ${method} ${url.pathname} threw: ${describeError(error)}\n`,
				);
				failResponse(res);
			}
			return;
		}

		// Longest-prefix match, not registration-order: two plugins can register nested prefixes
		// (e.g. "/" and "/docs/"), and whichever registered first must not permanently shadow the
		// other just because every path also starts with "/".
		const staticEntry = staticEntries
			.filter((entry) => url.pathname.startsWith(entry.prefix))
			.sort((a, b) => b.prefix.length - a.prefix.length)[0];
		if (staticEntry) {
			await serveStatic(staticEntry, url.pathname, res);
			return;
		}

		res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
	}

	const server: Server = createServer((req, res) => {
		// Backstop for anything handleRequest itself didn't anticipate - an unhandled rejection
		// here would otherwise take the whole daemon (and every process it supervises) down.
		handleRequest(req, res).catch((error: unknown) => {
			process.stderr.write(
				`${braidTag()} request ${req.method} ${req.url} failed: ${describeError(error)}\n`,
			);
			failResponse(res);
		});
	});

	server.on("upgrade", (req, socket, head) => {
		// An upgrade socket has no 'error' listener of its own - without one, a client resetting
		// the connection (a closed tab) is an uncaught ECONNRESET that kills the daemon.
		socket.on("error", () => socket.destroy());
		const url = parseRequestUrl(req.url);
		if (
			!url ||
			!isLoopbackHost(req.headers.host) ||
			!isSameOriginRequest(req.headers)
		) {
			socket.destroy();
			return;
		}
		// The cookie a prior GET's ?token= redirect already established authenticates an upgrade
		// too, not just the raw query token - without this, a page that's otherwise never had to
		// keep the secret in reach of its own JS would have no way to open a WebSocket without
		// putting it in a URL (visible in devtools/history/a screen share) purely for this.
		const authenticated =
			safeEqual(url.searchParams.get("token") ?? "", token) ||
			safeEqual(readCookie(req, cookieName) ?? "", token);
		const handler = authenticated ? upgrades.get(url.pathname) : undefined;
		if (!handler) {
			socket.destroy();
			return;
		}
		const fail = (error: unknown): void => {
			process.stderr.write(
				`${braidTag()} upgrade handler for ${url.pathname} threw: ${describeError(error)}\n`,
			);
			socket.destroy();
		};
		try {
			// UpgradeHandler is typed `=> void`, but an async function is still assignable to it -
			// catch its rejection too, not just a synchronous throw.
			const result: unknown = handler(req, socket, head);
			if (result instanceof Promise) result.catch(fail);
		} catch (error) {
			fail(error);
		}
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
