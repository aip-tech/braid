// A stand-in for a real codegen step (e.g. graphql-codegen) - reads a "schema" file and writes
// a "generated" one, used as a beforeRestart/dependsOn.run hook so a dependent process's restart
// only ever sees output that's actually current for what triggered it.
import { readFileSync, writeFileSync } from "node:fs";

const [, , sourcePath, outputPath, label] = process.argv;
const source = JSON.parse(readFileSync(sourcePath, "utf8"));

writeFileSync(
	outputPath,
	JSON.stringify({ ...source, generatedAt: new Date().toISOString() }, null, 2),
);
console.log(`[${label}] regenerated ${outputPath} from ${sourcePath}`);
