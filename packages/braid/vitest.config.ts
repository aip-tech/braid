import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		reporters: ["verbose", ...configDefaults.reporters],
		environment: "node",
		globals: true,
		include: ["src/**/*.spec.ts"],
		coverage: {
			provider: "istanbul",
			// Every statement, branch, function and line - anything deliberately left untested is
			// marked with a justified `istanbul ignore` instead, so a gap can't slip in unnoticed.
			thresholds: { 100: true },
			reporter: ["text", "html"],
			include: ["src/**/*.ts"],
		},
	},
});
