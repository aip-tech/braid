import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	base: "/braid/",
	build: {
		outDir: "dist",
		rollupOptions: {
			input: {
				home: resolve(__dirname, "index.html"),
				gettingStarted: resolve(__dirname, "docs/getting-started.html"),
				config: resolve(__dirname, "docs/config.html"),
				cli: resolve(__dirname, "docs/cli.html"),
				plugins: resolve(__dirname, "docs/plugins.html"),
			},
		},
	},
});
