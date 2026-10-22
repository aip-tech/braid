// Prints a goodbye on SIGTERM, takes a moment, then exits cleanly - the shutdown output a log
// should still capture.
console.log(`started ${process.pid}`);
process.on("SIGTERM", () => {
	console.log("graceful shutdown, flushing state");
	setTimeout(() => {
		console.log("done, bye");
		process.exit(0);
	}, 200);
});
setInterval(() => {}, 1000);
