import type { EventEmitter } from "node:events";
import type { ControlServer } from "./control-server.js";
import type {
	BraidPlugin,
	PluginContext,
	PluginLifecycleEvent,
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
};

/**
 * Returns a function that builds one PluginContext per plugin. Each plugin
 * gets its own instance (not a single shared object) purely so log() can
 * prefix the right plugin name - registerRoute/registerStatic/registerUpgrade
 * and getProcesses() delegate to the same underlying control server and
 * worker snapshot for every plugin.
 */
export function createPluginContextFactory(
	options: ContextFactoryOptions,
): (pluginName: string) => PluginContext {
	const { controlServer, getWorkers, emitter } = options;
	return (pluginName: string): PluginContext => ({
		registerRoute: controlServer.registerRoute,
		registerStatic: controlServer.registerStatic,
		registerUpgrade: controlServer.registerUpgrade,
		on(type, handler) {
			emitter.on(type, handler);
		},
		getProcesses: getWorkers,
		log(message) {
			process.stderr.write(`[plugin:${pluginName}] ${message}\n`);
		},
	});
}

/**
 * Calls a plugin's register(), catching both a synchronous throw and a
 * rejected promise from an async register() - `await` on a call that throws
 * synchronously lands in the same catch block as one that returns a rejected
 * promise, so one try/catch covers both failure modes. Used for core plugins
 * and external plugins alike, so neither can take the manager down.
 */
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

/**
 * Dispatches a lifecycle event to every listener registered for `type`,
 * isolating each call individually instead of calling emitter.emit()
 * directly. emit() propagates a listener's synchronous throw straight to
 * whatever called it (here, code inside a child's "exit" handler with no
 * surrounding try/catch), which would hit Node's default uncaughtException
 * handling and crash the whole manager; an async listener's rejected promise
 * is a second, separate failure mode (unhandled rejection, also fatal by
 * default) that a bare try/catch around emit() wouldn't catch either. Both
 * are guarded here.
 */
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
					`[braid] a lifecycle listener for "${type}" failed: ${
						error instanceof Error ? error.message : String(error)
					}\n`,
				);
			}
		}),
	);
}
