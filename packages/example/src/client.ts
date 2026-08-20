// Demonstrates `dependsOn`: restarts whenever api restarts (but only once api's readyPattern
// actually matches), regenerating client-sdk.json first via dependsOn.run.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const generatedPath = join(import.meta.dirname, "client-sdk.json");
let generated: unknown;
try {
	generated = JSON.parse(readFileSync(generatedPath, "utf8"));
} catch {
	generated =
		"not generated yet - it's created by dependsOn.run once api first restarts";
}

console.log(`client started (pid ${process.pid})`);
console.log("client-sdk.json:", generated);
setInterval(() => {}, 2000);
