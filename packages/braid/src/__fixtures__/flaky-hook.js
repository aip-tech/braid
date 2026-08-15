import {
	appendFileSync,
	existsSync,
	readFileSync,
	writeFileSync,
} from "node:fs";

const [, , counterPath, markerPath, failuresBeforeSuccessRaw] = process.argv;
const failuresBeforeSuccess = Number.parseInt(failuresBeforeSuccessRaw, 10);
const attempts = existsSync(counterPath)
	? Number.parseInt(readFileSync(counterPath, "utf8"), 10)
	: 0;

if (attempts < failuresBeforeSuccess) {
	writeFileSync(counterPath, String(attempts + 1));
	console.error(`flaky-hook: attempt ${attempts + 1} failing on purpose`);
	process.exit(1);
}

appendFileSync(markerPath, `${Date.now()}\n`);
process.exit(0);
