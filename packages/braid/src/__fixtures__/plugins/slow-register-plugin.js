// A plugin whose register() takes longer than a short `startupTimeoutMs`, standing in for a slow
// plugin or a cold TypeScript compile - the daemon is still booting when the CLI gives up on it.
export default {
	name: "slow-register",
	register() {
		return new Promise((resolve) => setTimeout(resolve, 3000));
	},
};
