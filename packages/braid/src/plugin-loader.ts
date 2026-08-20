import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolve as resolveEsm } from "import-meta-resolve";
import { registerPlugin } from "./plugin-runtime.js";
import { braidTag } from "./prefix.js";
import type { BraidPlugin, PluginConfigEntry, PluginContext } from "./types.js";

function splitEntry(entry: PluginConfigEntry): {
	specifier: string;
	options?: Record<string, unknown>;
} {
	return Array.isArray(entry)
		? { specifier: entry[0], options: entry[1] }
		: { specifier: entry };
}

// Resolves relative to configPath, not this package, so a bare specifier is found in the config
// author's own node_modules.
export function resolvePluginModule(
	specifier: string,
	configPath: string,
): URL {
	if (specifier.startsWith(".") || isAbsolute(specifier)) {
		const filePath = isAbsolute(specifier)
			? specifier
			: join(dirname(configPath), specifier);
		return pathToFileURL(filePath);
	}
	return new URL(resolveEsm(specifier, pathToFileURL(configPath).href));
}

function isBraidPlugin(value: unknown): value is BraidPlugin {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { name?: unknown }).name === "string" &&
		typeof (value as { register?: unknown }).register === "function"
	);
}

function logLoaderFailure(
	specifier: string,
	stage: string,
	detail: unknown,
): void {
	const message = detail instanceof Error ? detail.message : String(detail);
	process.stderr.write(
		`${braidTag()} plugin "${specifier}" ${stage}: ${message}\n`,
	);
}

/** Resolves, imports, and registers every configured external plugin. A broken one is logged and skipped. */
export async function loadExternalPlugins(
	entries: PluginConfigEntry[],
	configPath: string,
	contextFor: (pluginName: string) => PluginContext,
): Promise<void> {
	for (const entry of entries) {
		const { specifier, options } = splitEntry(entry);

		let moduleUrl: URL;
		try {
			moduleUrl = resolvePluginModule(specifier, configPath);
		} catch (error) {
			logLoaderFailure(specifier, "failed to resolve", error);
			continue;
		}

		let imported: unknown;
		try {
			imported = await import(moduleUrl.href);
		} catch (error) {
			logLoaderFailure(specifier, "failed to import", error);
			continue;
		}

		const candidate = (imported as { default?: unknown }).default;
		if (!isBraidPlugin(candidate)) {
			process.stderr.write(
				`${braidTag()} plugin "${specifier}" does not default-export a { name, register } plugin\n`,
			);
			continue;
		}

		await registerPlugin(candidate, contextFor(candidate.name), options);
	}
}
