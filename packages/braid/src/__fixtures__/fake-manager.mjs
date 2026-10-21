// Impersonates a running braid manager that won't stop: it writes a pidfile naming itself,
// answers every control-server request with 404 (as braid <0.10 does for /api/shutdown), and
// ignores SIGTERM - so the only way `braid stop` can end it is the SIGKILL after the deadline.
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";

const [pidfilePath, shutdownTimeoutMs] = process.argv.slice(2);
process.on("SIGTERM", () => {});
const server = createServer((_req, res) => res.writeHead(404).end());
server.listen(0, "127.0.0.1", () => {
	writeFileSync(
		pidfilePath,
		JSON.stringify({
			managerPid: process.pid,
			startedAt: new Date().toISOString(),
			workers: [],
			controlPort: server.address().port,
			controlToken: "fake",
			shutdownTimeoutMs: Number(shutdownTimeoutMs),
		}),
	);
	console.log("ready");
});
