import { existsSync, readFileSync, writeFileSync } from "node:fs";

const [, , counterPath, failuresBeforeSuccessRaw] = process.argv;
const failuresBeforeSuccess = Number.parseInt(failuresBeforeSuccessRaw, 10);
const attempts = existsSync(counterPath)
	? Number.parseInt(readFileSync(counterPath, "utf8"), 10)
	: 0;

if (attempts < failuresBeforeSuccess) {
	writeFileSync(counterPath, String(attempts + 1));
	console.error(`flaky-app: attempt ${attempts + 1} crashing on purpose`);
	process.exit(1);
}

console.log(`started ${process.pid}`);
setInterval(() => {}, 1000);
