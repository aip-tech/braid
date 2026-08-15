console.log(`started ${process.pid}`);
for (let i = 0; i < 500; i++) {
	console.log(`chatty-line-${i}-${"x".repeat(40)}`);
}
setInterval(() => {}, 1000);
