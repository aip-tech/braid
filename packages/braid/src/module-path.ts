import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolve as resolveEsm } from "import-meta-resolve";

/** Resolves the path to a sibling entrypoint module fork()ed at runtime (e.g. worker.ts). */
export function siblingModulePath(importMetaUrl: string, name: string): string {
	const callerPath = fileURLToPath(importMetaUrl);
	const runningFromSource = callerPath.endsWith(".ts");
	return join(
		dirname(callerPath),
		runningFromSource ? `${name}.ts` : `${name}.js`,
	);
}

/** True when the calling module is running from its .ts source rather than compiled .js (dist). */
export function isRunningFromSource(importMetaUrl: string): boolean {
	return fileURLToPath(importMetaUrl).endsWith(".ts");
}

// Resolved relative to the caller, not the forked child's cwd - the child's cwd may not have
// tsx reachable from it at all (e.g. a daemon forked into the invoking user's own project).
export function sourceExecArgv(importMetaUrl: string): string[] {
	if (!isRunningFromSource(importMetaUrl)) return [];
	return ["--import", resolveEsm("tsx", importMetaUrl)];
}
