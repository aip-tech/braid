import { appendFileSync, readFileSync } from "node:fs";

const [, , pidFilePath, markerPath] = process.argv;
const pid = Number.parseInt(readFileSync(pidFilePath, "utf8").trim(), 10);

try {
	process.kill(pid, 0);
	console.error(`assert-pid-dead-then-mark: pid ${pid} is still alive`);
	process.exit(1);
} catch {
	// Expected: the old process must already be dead by the time this hook runs.
}

appendFileSync(markerPath, `${Date.now()}\n`);
process.exit(0);
