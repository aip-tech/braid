export default {
	name: "ok",
	register(ctx, options) {
		ctx.registerRoute("GET", "/ok", (_req, res) => {
			res
				.writeHead(200, { "content-type": "text/plain" })
				.end(options?.reply ?? "ok");
		});
		ctx.on("processStart", () => {
			ctx.log("saw processStart");
		});
		ctx.log("registered");
	},
};
