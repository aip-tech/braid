import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		reporters: ["verbose", ...configDefaults.reporters],
		environment: "node",
		globals: true,
		include: [
			"src/**/*.spec.ts",
			"frontend/src/**/*.spec.ts",
			"frontend/src/**/*.spec.tsx",
		],
		coverage: {
			provider: "istanbul",
			reporter: ["text", "html"],
			include: ["src/**/*.ts", "frontend/src/**/*.ts", "frontend/src/**/*.tsx"],
		},
	},
});
