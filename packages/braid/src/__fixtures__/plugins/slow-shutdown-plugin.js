// Holds the daemonShutdown phase open for a while, so a test can land a crash inside an
// already-started shutdown, before any process has been asked to stop.
export default {
	name: "slow-shutdown",
	register(ctx) {
		ctx.on(
			"daemonShutdown",
			() => new Promise((resolve) => setTimeout(resolve, 1500)),
		);
	},
};
