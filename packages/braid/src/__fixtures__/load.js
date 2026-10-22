// A two-level process tree that uses real resources, for checking stats cover the whole tree:
// this process (the "app") spawns a child that holds `mb` megabytes of random - so incompressible -
// memory and keeps one core about half busy. The parent itself stays light, so stats that only
// measured the root would miss nearly all of it.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const [role = "parent", mbArg = "100"] = process.argv.slice(2);
const mb = Number(mbArg);

if (role === "parent") {
	console.log(`started ${process.pid}`);
	const child = spawn(
		process.execPath,
		[fileURLToPath(import.meta.url), "child", String(mb)],
		{
			stdio: "inherit",
		},
	);
	const stop = () => {
		child.kill("SIGKILL");
		process.exit(0);
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
	setInterval(() => {}, 1000);
} else {
	const held = [];
	for (let i = 0; i < mb; i++) held.push(randomBytes(1024 * 1024));
	console.log(`child ${process.pid} holding ${mb} MB`);
	// ~50% of one core: busy for 50ms out of every 100ms.
	setInterval(() => {
		const until = Date.now() + 50;
		while (Date.now() < until) {}
	}, 100);
}
