// Produces an unhandled rejection inside a running daemon, a little after startup - standing in
// for any bug, in braid or a plugin, that nothing else catches.
export default {
	name: "rejecting",
	register(ctx) {
		ctx.on("controlServerReady", () => {
			setTimeout(() => {
				Promise.reject(new Error("boom from a plugin"));
			}, 300);
		});
	},
};
