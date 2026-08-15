import type { ProcessConfig } from "./types.js";

/** Returns the first cycle found (as a name path, e.g. `["web", "api", "web"]`), if any. */
export function findDependencyCycle(
	configs: ProcessConfig[],
): string[] | undefined {
	const dependsOn = new Map<string, string[]>(
		configs.map((config) => [config.name, config.dependsOn?.processes ?? []]),
	);

	const UNVISITED = 0;
	const IN_PROGRESS = 1;
	const DONE = 2;
	const state = new Map<string, 0 | 1 | 2>(
		configs.map((config) => [config.name, UNVISITED]),
	);
	const path: string[] = [];

	function visit(name: string): string[] | undefined {
		state.set(name, IN_PROGRESS);
		path.push(name);
		for (const dependency of dependsOn.get(name) ?? []) {
			if (state.get(dependency) === IN_PROGRESS) {
				return [...path.slice(path.indexOf(dependency)), dependency];
			}
			if (state.get(dependency) === UNVISITED) {
				const cycle = visit(dependency);
				if (cycle) return cycle;
			}
		}
		path.pop();
		state.set(name, DONE);
		return undefined;
	}

	for (const name of state.keys()) {
		if (state.get(name) === UNVISITED) {
			const cycle = visit(name);
			if (cycle) return cycle;
		}
	}
	return undefined;
}

/**
 * Throws if any `dependsOn.processes` entry names a process that isn't configured, names the
 * process itself, or the graph as a whole loops back on itself (which would restart forever).
 */
export function validateDependsOn(configs: ProcessConfig[]): void {
	const names = new Set(configs.map((config) => config.name));

	for (const config of configs) {
		for (const dependency of config.dependsOn?.processes ?? []) {
			if (dependency === config.name) {
				throw new Error(
					`braid: process "${config.name}" cannot depend on itself`,
				);
			}
			if (!names.has(dependency)) {
				throw new Error(
					`braid: process "${config.name}" depends on unknown process "${dependency}"`,
				);
			}
		}
	}

	const cycle = findDependencyCycle(configs);
	if (cycle) {
		throw new Error(
			`braid: circular restart dependency: ${cycle.join(" -> ")}`,
		);
	}
}
