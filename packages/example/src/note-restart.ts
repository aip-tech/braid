// A stand-in for "rebuild a shared workspace package" - api's onRestart hook.
import { appendFileSync } from "node:fs";
import { join } from "node:path";

appendFileSync(
	join(import.meta.dirname, "restart-log.txt"),
	`api restarted at ${new Date().toISOString()}\n`,
);
console.log("note-restart: appended to restart-log.txt");
