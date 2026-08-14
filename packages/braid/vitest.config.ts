import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
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
