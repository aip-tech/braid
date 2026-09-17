import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		reporters: ["verbose", ...configDefaults.reporters],
		environment: "node",
		globals: true,
		include: ["src/**/*.spec.ts"],
		coverage: {
			provider: "istanbul",
			reporter: ["text", "html"],
			include: ["src/**/*.ts"],
		},
	},
});
