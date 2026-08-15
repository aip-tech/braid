import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolve as resolveEsm } from "import-meta-resolve";

/**
 * Resolves the path to a sibling entrypoint module that gets fork()ed at
 * runtime (worker.ts from manager.ts, daemon.ts from cli.ts). Compiled output
 * (dist/manager.js) sits next to a compiled dist/worker.js; running straight
 * from source (dev, tests) sits next to worker.ts and needs tsx's loader to
 * fork() it directly - callers pass their own `import.meta.url` so this
 * resolves relative to the CALLING module's location, not module-path.ts's own.
 */
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

/**
 * Extra execArgv needed to fork() a sibling .ts entrypoint directly when running from source (dev,
 * tests) - the compiled .js entrypoint is plain JS and needs none of this. Resolves tsx's own
 * loader specifier via import-meta-resolve, anchored at the CALLING module's own location, not the
 * forked child's eventual cwd - for a forked daemon in particular, that cwd is the invoking user's
 * project directory, which has no reason to have tsx reachable from it at all.
 */
export function sourceExecArgv(importMetaUrl: string): string[] {
	if (!isRunningFromSource(importMetaUrl)) return [];
	return ["--import", resolveEsm("tsx", importMetaUrl)];
}
