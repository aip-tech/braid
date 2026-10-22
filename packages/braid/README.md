# braid

Run every process your project needs as one stack. Describe your API, web app and workers in one
config file; braid starts them in the right order, restarts them when files change, handles
crashes, and keeps their logs.

**[Documentation](https://aip-tech.github.io/braid/)** ·
[Changelog](./CHANGELOG.md) ·
[GitHub](https://github.com/aip-tech/braid)

Requires Node 22.18 or later, on macOS or Linux.

## Install

```bash
npm install --save-dev @aip-tech/braid
```

## Configure

Create `braid.config.ts` next to your `package.json`:

```ts
import { defineConfig } from "@aip-tech/braid";

export default defineConfig({
	processes: [
		{
			name: "api",
			command: "pnpm",
			args: ["--filter", "./api", "dev"],
			watch: ["api/src"],
			readyPattern: "^Server listening",
		},
		{
			name: "web",
			command: "pnpm",
			args: ["--filter", "./web", "dev"],
			startAfter: { processes: ["api"] },
		},
	],
});
```

In a project whose `package.json` isn't `"type": "module"` (`npm init` sets `"commonjs"`), name the
file `braid.config.mts` instead; braid finds either.

Here `api` restarts when a file under `api/src` changes, and `web` waits for `api` to print its
ready line before starting. See the [configuration guide](https://aip-tech.github.io/braid/docs/config.html)
and the [full list of options](https://aip-tech.github.io/braid/docs/reference.html).

## Run

```bash
npx braid start            # start the stack in the background
npx braid status           # state, CPU and memory for each process
npx braid logs --follow    # every process's output, live
npx braid restart api      # restart one process
npx braid stop             # stop everything
```

Add `--foreground` to `start` to stay attached to the terminal instead. Every command and flag is in
the [CLI reference](https://aip-tech.github.io/braid/docs/cli.html).

## Features

- **Restarts on file changes**, with extension filters and excludes.
- **Dependencies between processes:** wait for readiness on first start, restart dependents when a
  process restarts, and run commands such as codegen in between.
- **Crash handling:** a crash stops the whole stack by default, or restarts just that process with
  backoff.
- **Persistent logs:** a rotated log file per process, readable with `braid logs`.
- **Real resource usage:** CPU and memory for each app's whole process tree.
- **Plugins:** add routes, pages and event listeners to the stack's local control server. The
  [web dashboard](https://www.npmjs.com/package/@aip-tech/braid-plugin-ui) is one.

## License

MIT
