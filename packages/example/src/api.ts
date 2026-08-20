// Demonstrates `readyPattern` (client below waits for the "api listening" line, not just a
// respawn) and `onRestart` (note-restart.ts runs after every restart of this process itself).
// Edit this file while `pnpm dev` is running to see both in action.
import { createServer } from "node:http";

const port = 4002;

const server = createServer((_req, res) => {
	res.end(`hello from api (pid ${process.pid})\n`);
});

server.listen(port, () => {
	console.log(`api listening on http://localhost:${port}`);
});
