import type { BraidPlugin } from "../types.js";

/**
 * Core functionality written as a plugin - proves PluginContext against a
 * real consumer instead of a contrived example - but compiled into
 * @aip-tech/braid itself and statically imported (see ./index.ts), never
 * resolved dynamically and never listed in anyone's `plugins` config.
 */
export const statusPlugin: BraidPlugin = {
	name: "core:status",
	register(ctx) {
		ctx.registerRoute("GET", "/api/status", (_req, res) => {
			const body = JSON.stringify(ctx.getProcesses());
			res.writeHead(200, { "content-type": "application/json" }).end(body);
		});
	},
};
