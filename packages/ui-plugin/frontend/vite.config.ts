import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	root: __dirname,
	// Relative, not root-absolute, asset references - the dashboard can be registered under any
	// prefix (UiPluginOptions.path), not just "/", and a relative base works under all of them
	// without needing to know the prefix at build time.
	base: "./",
	esbuild: {
		jsx: "automatic",
		jsxImportSource: "preact",
	},
	build: {
		outDir: resolve(__dirname, "../dist/public"),
		emptyOutDir: true,
	},
});
