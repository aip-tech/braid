console.log(`started ${process.pid}`);
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
