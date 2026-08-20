const delayMs = Number.parseInt(process.argv[2] ?? "0", 10);
await new Promise((resolve) => setTimeout(resolve, delayMs));
console.log("slow-hook ran");
process.exit(0);
