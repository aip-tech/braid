// Calls ctx.shutdown() - during register() (too early: ignored), or once the daemon is up.
export default {
	name: "shutdown",
	register(ctx, options) {
		if (options?.when === "register") ctx.shutdown();
		if (options?.when === "ready") {
			ctx.on("controlServerReady", () => {
				setTimeout(() => ctx.shutdown(), 200);
			});
		}
	},
};
