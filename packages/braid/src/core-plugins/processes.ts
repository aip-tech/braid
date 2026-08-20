import type { ServerResponse } from "node:http";
import type { BraidPlugin, ProcessActionResult } from "../types.js";

function respond(
	res: ServerResponse,
	result: ProcessActionResult,
	unknownMessage: string,
): void {
	if (result === "ok") {
		res.writeHead(200, { "content-type": "text/plain" }).end("ok");
		return;
	}
	if (result === "busy") {
		res
			.writeHead(409, { "content-type": "text/plain" })
			.end("busy: a restart is already in progress for this process");
		return;
	}
	res.writeHead(404, { "content-type": "text/plain" }).end(unknownMessage);
}

export const processesPlugin: BraidPlugin = {
	name: "core:processes",
	register(ctx) {
		ctx.registerRoute("POST", "/api/processes/stop", async (req, res) => {
			const url = new URL(req.url ?? "/", "http://localhost");
			const name = url.searchParams.get("name");
			if (!name) {
				res
					.writeHead(400, { "content-type": "text/plain" })
					.end("name query param required");
				return;
			}
			respond(
				res,
				await ctx.stopProcess(name),
				"unknown process, or it isn't currently running",
			);
		});
		ctx.registerRoute("POST", "/api/processes/restart", async (req, res) => {
			const url = new URL(req.url ?? "/", "http://localhost");
			const name = url.searchParams.get("name");
			if (!name) {
				res
					.writeHead(400, { "content-type": "text/plain" })
					.end("name query param required");
				return;
			}
			respond(res, await ctx.restartProcess(name), "unknown process");
		});
	},
};
