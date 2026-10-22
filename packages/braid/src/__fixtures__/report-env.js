// Prints which BRAID_* variables it inherited, and whether it can see the secret it's told to look
// for - another process's own `env` value, which must never leak across.
const [otherSecretName] = process.argv.slice(2);
const braid = Object.keys(process.env)
	.filter((key) => key.startsWith("BRAID_"))
	.sort();
console.log(
	`env-report ${JSON.stringify({ braid, sawOther: process.env[otherSecretName] ?? null })}`,
);
setInterval(() => {}, 1000);
