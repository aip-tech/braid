const delayMs = Number.parseInt(process.argv[2] ?? "0", 10);

setTimeout(() => {
	console.error("boom");
	process.exit(1);
}, delayMs);
