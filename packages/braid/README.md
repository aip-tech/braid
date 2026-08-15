# braid

Runs multiple long-lived processes as one unit, as a background daemon: PID tracking, nodemon-driven restarts, kill-everything-on-crash, and persistent rotated per-process logs.

Published on npm as `@aip-tech/braid`. See [CHANGELOG.md](./CHANGELOG.md) for release notes.

## Install

```bash
npm install @aip-tech/braid
```

## Config

`braid.config.ts`:

```ts
import { defineConfig } from "@aip-tech/braid";

export default defineConfig({
	processes: [
		{ name: "api", command: "pnpm", args: ["--filter", "./api", "run", "dev"], watch: ["api/src"] },
		{ name: "client", command: "pnpm", args: ["--filter", "./client", "run", "dev"] },
	],
});
```

- `watch`: restart this process via nodemon when these paths change. Omit it for a command that manages its own reload.
- `plugins`: external plugins to load, by package name/path (or a `[name, options]` tuple).
- `logs`: `{ dir, maxSizeBytes }` — see [Logs](#logs).

Full field list and defaults: [`src/types.ts`](./src/types.ts) (`ProcessConfig`, `BraidConfig`).

## CLI

```bash
npx @aip-tech/braid start                    # start every configured process as a background daemon
npx @aip-tech/braid status                   # list each process's name/pid/alive state
npx @aip-tech/braid logs [name]              # print a process's log (every process, interleaved, if no name)
npx @aip-tech/braid logs [name] --follow     # keep streaming new output
npx @aip-tech/braid logs [name] --lines 50   # only the last 50 lines
npx @aip-tech/braid stop                     # kill everything
npx @aip-tech/braid start --config ./other.config.ts
```

Or just `braid ...` if installed as a dependency and run via a package.json script — see [`packages/example`](../example).

## Logs

Each process gets a rotated log file at `.braid/logs/<name>.log`. Rotated (one backup kept) on every `start`, on a nodemon-triggered restart, and past `logs.maxSizeBytes` (default 5MB). Braid's own diagnostics (plugin failures, crash notices) go to `.braid/daemon.log`.

## Plugins

`start` runs a loopback-only, token-guarded control server that plugins register routes on. List a plugin by package name/path in `plugins` to load it — see `PluginContext` in [`src/types.ts`](./src/types.ts). No external plugins ship yet.

## Scripts

```bash
pnpm build        # tsc -> dist/
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run
pnpm coverage     # vitest run --coverage
```
