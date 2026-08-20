import { DEFAULT_LOG_MAX_SIZE_BYTES, defineConfig } from "@aip-tech/braid";

export default defineConfig({
	logs: {
		maxSizeBytes: DEFAULT_LOG_MAX_SIZE_BYTES,
		dir: ".braid/logs",
		timestamps: true,
	},
	foreground: false,
	// Check .braid/daemon.log (or the terminal, under --foreground) for the dashboard's
	// open-this-URL line once the daemon's up.
	plugins: ["@aip-tech/braid-plugin-ui"],
	processes: [
		{
			// Plain `watch`, no hooks. Edit src/web.ts and save to see it restart.
			name: "web",
			color: "blue",
			command: "tsx",
			args: ["src/web.ts"],
			watch: ["src/web.ts"],
			ext: "ts",
		},
		{
			// No `watch` set: runs once, still PID-tracked and torn down with the rest.
			name: "worker",
			color: "yellow",
			command: "tsx",
			args: ["src/worker.ts"],
		},
		{
			// `readyPattern` + `onRestart`. Edit src/api.ts and save: client (below) waits for the
			// "api listening" line, not just a respawn, before its own dependsOn cascade runs; and
			// note-restart.ts runs after every restart of api itself, regardless of any dependents.
			name: "api",
			color: "magenta",
			command: "tsx",
			args: ["src/api.ts"],
			watch: ["src/api.ts"],
			ext: "ts",
			readyPattern: "api listening",
			onRestart: { command: "tsx", args: ["src/note-restart.ts"] },
		},
		{
			// `dependsOn` + `run`. Regenerates client-sdk.json from schema.json once api restarts
			// (and is confirmed ready), then restarts to pick it up.
			name: "client",
			color: "cyan",
			command: "tsx",
			args: ["src/client.ts"],
			dependsOn: {
				processes: ["api"],
				run: {
					command: "tsx",
					args: [
						"src/generate.ts",
						"src/schema.json",
						"src/client-sdk.json",
						"client",
					],
				},
			},
		},
		{
			// `beforeRestart` - the real scenario this hook exists for: a process that needs to
			// regenerate its own on-disk dependency from the very files it watches, reliably,
			// before it restarts. Edit src/schema.json's "greeting" and save to see it in action.
			name: "codegen",
			color: "green",
			command: "tsx",
			args: ["src/codegen.ts"],
			watch: ["src/codegen.ts", "src/schema.json"],
			ext: "ts,json",
			beforeRestart: {
				command: "tsx",
				args: [
					"src/generate.ts",
					"src/schema.json",
					"src/generated-sdk.json",
					"codegen",
				],
			},
		},
	],
});
