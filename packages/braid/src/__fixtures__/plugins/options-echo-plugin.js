export default {
	name: "options-echo",
	register(ctx, options) {
		ctx.log(JSON.stringify(options ?? null));
	},
};
