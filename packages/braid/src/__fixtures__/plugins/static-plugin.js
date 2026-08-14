import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default {
	name: "static",
	register(ctx) {
		ctx.registerStatic("/static/", join(__dirname, "static-plugin-public"));
	},
};
