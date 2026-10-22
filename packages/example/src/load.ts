// A process tree whose resource use climbs, so the dashboard's CPU and memory figures (and their
// sparklines) visibly move. It spawns one child that gains 10 MB of incompressible memory a second
// up to 300 MB, then lets it all go and starts again, while keeping roughly a quarter of a core busy.
// Everything happens in the child: stats that only measured this parent would stay flat at its own
// ~50 MB, which is what this is here to catch.
import { spawn } from "node:child_process";

const CHILD = `
const { randomBytes } = require("node:crypto");
let held = [];
setInterval(() => {
	held.push(randomBytes(10 * 1024 * 1024));
	if (held.length > 30) held = [];
	console.log("load child holding " + held.length * 10 + " MB");
}, 1000);
setInterval(() => {
	const until = Date.now() + 25;
	while (Date.now() < until) {}
}, 100);
`;

const child = spawn(process.execPath, ["-e", CHILD], { stdio: "inherit" });
console.log(`load parent ${process.pid}, child ${child.pid}`);

const stop = () => {
	child.kill("SIGKILL");
	process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
