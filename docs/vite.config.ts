import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const __dirname = dirname(fileURLToPath(import.meta.url));
const braidVersion = (
	JSON.parse(
		readFileSync(resolve(__dirname, "../packages/braid/package.json"), "utf8"),
	) as { version: string }
).version;

const pages = [
	"getting-started",
	"config",
	"plugins",
	"reference",
	"cli",
	"plugin-api",
	"ui-plugin",
];

export default defineConfig({
	base: "/braid/",
	define: {
		// Shown in the top nav, so it always matches the package being documented.
		__BRAID_VERSION__: JSON.stringify(braidVersion),
	},
	build: {
		outDir: "dist",
		rollupOptions: {
			input: {
				home: resolve(__dirname, "index.html"),
				...Object.fromEntries(
					pages.map((page) => [page, resolve(__dirname, `docs/${page}.html`)]),
				),
			},
		},
	},
});
