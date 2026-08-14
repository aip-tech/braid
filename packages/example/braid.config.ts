import type { ProcessConfig } from "@aip-tech/braid";

const config: ProcessConfig[] = [
	{
		// Edit src/web.ts and save while `pnpm dev` is running to see it restart.
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
];

export default config;
