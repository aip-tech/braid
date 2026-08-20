import type { EventEmitter } from "node:events";
import type { ControlServer } from "./control-server.js";
import { braidTag, pluginTag } from "./prefix.js";
import type {
	BraidPlugin,
	PluginContext,
	PluginLifecycleEvent,
	ProcessActionResult,
} from "./types.js";

type WorkerSnapshot = {
	name: string;
	pid: number | undefined;
	alive: boolean;
	startedAt: string;
};

type ContextFactoryOptions = {
	controlServer: ControlServer;
	getWorkers: () => WorkerSnapshot[];
	emitter: EventEmitter;
	stopProcess: (name: string) => Promise<ProcessActionResult>;
	restartProcess: (name: string) => Promise<ProcessActionResult>;
};

/** Builds one PluginContext per plugin, so log() can prefix the right plugin name. */
export function createPluginContextFactory(
	options: ContextFactoryOptions,
): (pluginName: string) => PluginContext {
	const { controlServer, getWorkers, emitter, stopProcess, restartProcess } =
		options;
	return (pluginName: string): PluginContext => ({
		registerRoute: controlServer.registerRoute,
		registerStatic: controlServer.registerStatic,
		registerUpgrade: controlServer.registerUpgrade,
		on(type, handler) {
			emitter.on(type, handler);
		},
		getProcesses: getWorkers,
		stopProcess,
		restartProcess,
		log(message) {
			process.stderr.write(`${pluginTag(pluginName)} ${message}\n`);
		},
	});
}

/** Calls a plugin's register(), logging (not throwing) on a sync or async failure. */
export async function registerPlugin(
	plugin: BraidPlugin,
	ctx: PluginContext,
	options?: Record<string, unknown>,
): Promise<void> {
	try {
		await plugin.register(ctx, options);
	} catch (error) {
		ctx.log(
			`failed to register: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

// Not emitter.emit(): a throwing/rejecting listener there would crash the whole manager.
export async function safeEmit<T extends PluginLifecycleEvent["type"]>(
	emitter: EventEmitter,
	type: T,
	event: Extract<PluginLifecycleEvent, { type: T }>,
): Promise<void> {
	const listeners = emitter.listeners(type) as Array<
		(event: PluginLifecycleEvent) => void | Promise<void>
	>;
	await Promise.all(
		listeners.map(async (listener) => {
			try {
				await listener(event);
			} catch (error) {
				process.stderr.write(
					`${braidTag()} a lifecycle listener for "${type}" failed: ${
						error instanceof Error ? error.message : String(error)
					}\n`,
				);
			}
		}),
	);
}
