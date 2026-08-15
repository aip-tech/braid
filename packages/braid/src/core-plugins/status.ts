import type { BraidPlugin } from "../types.js";

export const statusPlugin: BraidPlugin = {
	name: "core:status",
	register(ctx) {
		ctx.registerRoute("GET", "/api/status", (_req, res) => {
			const body = JSON.stringify(ctx.getProcesses());
			res.writeHead(200, { "content-type": "application/json" }).end(body);
		});
	},
};
