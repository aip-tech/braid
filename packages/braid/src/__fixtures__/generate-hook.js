import { appendFileSync } from "node:fs";

const markerPath = process.argv[2];
console.log("generate-hook ran");
appendFileSync(markerPath, `${Date.now()}\n`);
process.exit(0);
