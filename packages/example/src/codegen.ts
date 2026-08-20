// Demonstrates `beforeRestart`: watches schema.json (and its own source) and regenerates
// generated-sdk.json before restarting, so it never boots against a stale generated file.
// Edit src/schema.json's "greeting" while `pnpm dev` is running to see this in action.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const generatedPath = join(import.meta.dirname, "generated-sdk.json");
let generated: unknown;
try {
	generated = JSON.parse(readFileSync(generatedPath, "utf8"));
} catch {
	generated =
		"not generated yet - it's created by beforeRestart on the first watched change";
}

console.log(`codegen started (pid ${process.pid})`);
console.log("generated-sdk.json:", generated);
setInterval(() => {}, 2000);
