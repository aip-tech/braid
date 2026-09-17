import type { IncomingMessage, ServerResponse } from "node:http";
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
			.end("busy: an operation is already in progress for this process");
		return;
	}
	res.writeHead(404, { "content-type": "text/plain" }).end(unknownMessage);
}

/** Reads the required `?name=` query param, writing a 400 and returning undefined if it's missing
 *  (an empty value is treated the same as an absent one). Shared by all three action routes below. */
function requireNameParam(
	req: IncomingMessage,
	res: ServerResponse,
): string | undefined {
	// istanbul ignore next -- `req.url` satisfies IncomingMessage's own optional typing; Node's HTTP
	// parser never emits a 'request' event without it already set (same reasoning as
	// control-server.ts's own identical fallbacks).
	const url = new URL(req.url ?? "/", "http://localhost");
	const name = url.searchParams.get("name");
	if (!name) {
		res
			.writeHead(400, { "content-type": "text/plain" })
			.end("name query param required");
		return undefined;
	}
	return name;
}

export const processesPlugin: BraidPlugin = {
	name: "core:processes",
	register(ctx) {
		ctx.registerRoute("POST", "/api/processes/stop", async (req, res) => {
			const name = requireNameParam(req, res);
			if (!name) return;
			respond(
				res,
				await ctx.stopProcess(name),
				"unknown process, or it isn't currently running",
			);
		});
		ctx.registerRoute("POST", "/api/processes/restart", async (req, res) => {
			const name = requireNameParam(req, res);
			if (!name) return;
			respond(res, await ctx.restartProcess(name), "unknown process");
		});
		ctx.registerRoute("POST", "/api/processes/start", async (req, res) => {
			const name = requireNameParam(req, res);
			if (!name) return;
			respond(res, await ctx.startProcess(name), "unknown process");
		});
	},
};
