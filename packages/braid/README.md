# braid

Runs multiple long-lived processes as one unit, as a background daemon by default (or attached to your terminal with `--foreground`): PID tracking, nodemon-driven restarts, kill-everything-on-crash, and persistent rotated per-process logs.

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
- `dependsOn`: `{ processes, run? }` — restart this process whenever any of `processes` restarts, optionally running a command first (e.g. codegen) and waiting for it to finish. See [Dependent restarts](#dependent-restarts).
- `onRestart`: run a command after this process itself restarts, e.g. rebuilding a shared workspace package. See [Post-restart hooks](#post-restart-hooks).
- `readyPattern`: hold off `onRestart`/`dependsOn` until this regex matches the process's own output after a restart. See [Waiting for readiness](#waiting-for-readiness).
- `plugins`: external plugins to load, by package name/path (or a `[name, options]` tuple).
- `logs`: `{ dir, maxSizeBytes }` — see [Logs](#logs).
- `foreground`: run `start` attached to the terminal instead of forking a background daemon. Overridable per invocation with `--foreground`/`--daemon`. @default `false`

Full field list and defaults: [`src/types.ts`](./src/types.ts) (`ProcessConfig`, `BraidConfig`).

## CLI

```bash
npx @aip-tech/braid start                    # start every configured process as a background daemon
npx @aip-tech/braid start --foreground       # ...or attached to this terminal (Ctrl-C stops everything)
npx @aip-tech/braid start --daemon           # force the background daemon, overriding a config's foreground: true
npx @aip-tech/braid status                   # list each process's name/pid/alive state
npx @aip-tech/braid logs [name]              # print a process's log (every process, interleaved, if no name)
npx @aip-tech/braid logs [name] --follow     # keep streaming new output
npx @aip-tech/braid logs [name] --lines 50   # only the last 50 lines
npx @aip-tech/braid stop                     # kill everything
npx @aip-tech/braid start --config ./other.config.ts
```

In `--foreground` mode, `start` blocks until every process stops (Ctrl-C, or `braid stop` from another terminal), streaming their combined output straight here instead of only to the log files.

## Dependent restarts

A process can restart whenever another one does — e.g. a client that needs to regenerate its GraphQL SDK once the API it talks to restarts:

```ts
{ name: "api", command: "pnpm", args: ["--filter", "./api", "run", "dev"], watch: ["api/src"] },
{
	name: "client",
	command: "pnpm",
	args: ["--filter", "./client", "run", "dev"],
	dependsOn: {
		processes: ["api"],
		run: { command: "pnpm", args: ["--filter", "./client", "run", "generate"] },
	},
},
```

When `api` restarts: `client` stops once `api` has actually re-spawned (not the instant nodemon decides to restart it), `run` executes (retried on failure — `retries`/`retryDelayMs`, default 5× / 1s apart, since `api` may still be starting back up), then `client` restarts. Left stopped with a logged reason if `run` never succeeds. A `dependsOn` chain that loops back on its own trigger is rejected at startup.

## Post-restart hooks

For a shared workspace package other processes just read from (no process of its own to restart), run a command directly after the process that changed it restarts:

```ts
{
	name: "api",
	command: "pnpm",
	args: ["--filter", "./api", "run", "dev"],
	watch: ["api/src"],
	onRestart: { command: "pnpm", args: ["--filter", "./types", "run", "generate"] },
},
```

Same shape and retry behavior as `dependsOn.run`, but scoped to `api` restarting itself — no dependent process is stopped or restarted. If `api` also has dependents (via `dependsOn`), they're notified only once this hook succeeds, and not at all if it never does.

## Waiting for readiness

Re-spawning a process isn't the same as it being ready — an API might take a moment after restarting before it's actually serving. `readyPattern` holds off `onRestart` and any `dependsOn` cascades until a regex matches that process's own stdout/stderr:

```ts
{
	name: "api",
	command: "pnpm",
	args: ["--filter", "./api", "run", "dev"],
	watch: ["api/src"],
	readyPattern: "Server listening",
	readyTimeoutMs: 15000, // @default 10000
},
```

Without `readyPattern`, dependents are held off only until `api` has re-spawned (not exited/killed while restarting, but not necessarily done starting up either) — a `run`/`onRestart` hook's own retry is what bridges the rest of that gap. If `readyPattern` never matches within `readyTimeoutMs`, braid logs why and proceeds anyway rather than holding dependents off forever on a misconfigured pattern.

## Logs

Each process gets a rotated log file at `.braid/logs/<name>.log`. Rotated (one backup kept) on every `start`, on a nodemon-triggered restart, and past `logs.maxSizeBytes` (default 5MB). Braid's own diagnostics (plugin failures, crash notices) go to `.braid/daemon.log`; a `dependsOn`/`onRestart` hook that keeps failing, or a `readyPattern` that never matches, is also logged into the relevant process's own log.

## Plugins

`start` runs a loopback-only, token-guarded control server that plugins register routes on. List a plugin by package name/path in `plugins` to load it — see `PluginContext` in [`src/types.ts`](./src/types.ts). No external plugins ship yet.

## Scripts

```bash
pnpm build        # tsc -> dist/
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run
pnpm coverage     # vitest run --coverage
```
