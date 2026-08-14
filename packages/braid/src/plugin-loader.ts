import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolve as resolveEsm } from "import-meta-resolve";
import { registerPlugin } from "./plugin-runtime.js";
import type { BraidPlugin, PluginConfigEntry, PluginContext } from "./types.js";

function splitEntry(entry: PluginConfigEntry): {
	specifier: string;
	options?: Record<string, unknown>;
} {
	return Array.isArray(entry)
		? { specifier: entry[0], options: entry[1] }
		: { specifier: entry };
}

/**
 * Resolves a config's plugin entry to a real module URL. A bare package
 * specifier ("@aip-tech/braid-plugin-ui") resolves from the config file's own
 * location via import-meta-resolve, Node's actual ESM resolver (exports maps,
 * conditions, all of it) - not a require.resolve()-based workaround, which
 * breaks on a pure-ESM plugin package whose package.json#exports has only an
 * "import" condition and no "require"/"default" fallback (exactly the shape a
 * Vite/tsc-built, "type": "module" plugin package will have). Resolving from
 * the config file matters: a plugin declared by a config author must be found
 * in *that author's* node_modules, not inside @aip-tech/braid's own - under
 * pnpm's symlinked layout those are different trees.
 *
 * A relative or absolute local-path entry (checked via node:path's
 * isAbsolute(), not a literal "/" prefix, so a Windows-authored absolute path
 * resolves too) is joined against the config file's directory directly, no
 * resolver needed.
 */
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
	process.stderr.write(`[braid] plugin "${specifier}" ${stage}: ${message}\n`);
}

/**
 * Resolves, loads, and registers every configured external plugin. Every
 * step - resolution, the dynamic import itself, shape validation, and
 * register() (via registerPlugin, see plugin-runtime.ts) - is isolated per
 * entry: one broken plugin is logged and skipped, never thrown, so it can't
 * stop the manager or any other plugin from working.
 */
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
				`[braid] plugin "${specifier}" does not default-export a { name, register } plugin\n`,
			);
			continue;
		}

		await registerPlugin(candidate, contextFor(candidate.name), options);
	}
}
