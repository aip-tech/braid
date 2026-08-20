import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BraidPlugin } from "@aip-tech/braid";

// __dirname here is dist/ at runtime (this file compiles to dist/index.js) - the frontend build
// puts its output at dist/public, a sibling of this compiled file, so this path holds whether
// running from source (a workspace/local-path plugin entry) or from the published npm tarball.
const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");

/**
 * Reads the host project's own installed `@aip-tech/braid` version straight from its
 * package.json - there's no other way to know it, since this plugin is built and published
 * independently and could be paired with any `@aip-tech/braid` version satisfying its peer range.
 */
function getBraidVersion(): string {
	try {
		const pkgUrl = import.meta.resolve("@aip-tech/braid/package.json");
		const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf8")) as {
			version?: string;
		};
		return pkg.version ?? "unknown";
	} catch {
		return "unknown";
	}
}

type UiPluginOptions = {
	/** URL prefix the dashboard is served under. @default "/" */
	path?: string;
};

export const uiPlugin: BraidPlugin = {
	name: "ui",
	register(ctx, rawOptions) {
		const options = (rawOptions ?? {}) as UiPluginOptions;
		const prefix = options.path ?? "/";
		// Resolved once at register() time, not per-request - it can't change while the daemon runs.
		const braidVersion = getBraidVersion();

		ctx.registerStatic(prefix, PUBLIC_DIR);
		ctx.registerRoute("GET", "/api/ui/version", (_req, res) => {
			res
				.writeHead(200, { "content-type": "application/json" })
				.end(JSON.stringify({ braidVersion }));
		});
		// Fires once the control server's real port/token are known - can't be read any earlier,
		// register() itself runs before controlServer.listen() resolves.
		ctx.on("controlServerReady", ({ port, token }) => {
			ctx.log(
				`dashboard ready - open http://127.0.0.1:${port}${prefix}?token=${token} in your browser`,
			);
		});
	},
};

export default uiPlugin;
