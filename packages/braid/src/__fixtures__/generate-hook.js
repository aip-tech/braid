import { appendFileSync } from "node:fs";

const markerPath = process.argv[2];
appendFileSync(markerPath, `${Date.now()}\n`);
process.exit(0);
