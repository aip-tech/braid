let tick = 0;

setInterval(() => {
	tick += 1;
	console.log(`worker tick ${tick} (pid ${process.pid})`);
}, 2000);
