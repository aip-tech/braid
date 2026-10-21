// Writes a line every 20ms for as long as it runs - so its worker is always mid-write to the
// manager's pipe, the exact situation where a dead manager turns the worker's next write into an
// EPIPE. With "trap-term", it also ignores SIGTERM, so stopping it needs the SIGKILL escalation.
// Survives its own stdout breaking (as plenty of real servers do), so if its worker dies it keeps
// running - an orphan - rather than conveniently dying of the same EPIPE.
process.stdout.on("error", () => {});
console.log(`started ${process.pid}`);
if (process.argv[2] === "trap-term") process.on("SIGTERM", () => {});
let i = 0;
setInterval(() => console.log(`line ${i++}`), 20);
