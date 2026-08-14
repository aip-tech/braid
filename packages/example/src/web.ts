import { createServer } from "node:http";

const port = 4001;

const server = createServer((_req, res) => {
	res.end(`hello from web (pid ${process.pid})\n`);
});

server.listen(port, () => {
	console.log(`web listening on http://localhost:${port}`);
});
