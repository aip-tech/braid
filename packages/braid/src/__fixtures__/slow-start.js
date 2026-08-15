const delayMs = Number.parseInt(process.argv[2] ?? "0", 10);

setTimeout(() => {
	console.log(`ready-marker ${process.pid}`);
}, delayMs);

setInterval(() => {}, 1000);
