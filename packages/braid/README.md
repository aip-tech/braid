# braid

Runs multiple long-lived processes as one unit: tracks their PIDs in a pidfile, restarts individual processes via [nodemon](https://github.com/remy/nodemon) when their watched files change, and kills every process together if one of them crashes or the manager itself is stopped. `start` runs as a detached background daemon with persistent, rotated per-process log files, not in the foreground.

Built as a replacement for ad hoc `concurrently`/shell-script setups in monorepo `dev` scripts, where you want more than "run these commands in parallel": PID tracking you can query or kill from a separate terminal, restart-on-change for only the processes that need it, a crash in one process taking the whole stack down together instead of leaving orphaned siblings running, and output that survives past the terminal that started it.

> **Status**: early-stage development. Core process management (PID tracking, nodemon-driven restarts, kill-everything-on-crash, daemonized `start` with persistent rotated logs) works and is tested, the CLI is a real compiled `bin` with no TypeScript required to run it, and CI covers typecheck/lint/test/build. `start` also runs a loopback-only, token-guarded control server with an internal plugin API (see [Plugins](#plugins) below) — nothing consumes it externally yet, but it's the foundation the roadmap's web dashboard will build on. Published on npm as `@aip-tech/braid`.

## Install

```bash
npm install @aip-tech/braid
```

## Config

A config file default-exports either an array of `ProcessConfig`, or a `{ processes, plugins }` object (see [`src/types.ts`](./src/types.ts)) when you also want to load a plugin:

```ts
import type { ProcessConfig } from "@aip-tech/braid";

const config: ProcessConfig[] = [
	{ name: "api", command: "pnpm", args: ["--filter", "./api", "run", "dev"], watch: ["api/src"] },
	{ name: "client", command: "pnpm", args: ["--filter", "./client", "run", "dev"] },
];

export default config;
```

Set `watch` (and optionally `ext`) when a process should restart on file changes; omit it when the command already manages its own reload (an internal `tsx watch`, a dev server with HMR, etc.) — that process still gets PID tracking and gets torn down with the rest, it just isn't wrapped in nodemon.

The object form also accepts an optional `logs` field controlling per-process log files (see [Logs](#logs)):

```ts
const config = {
	processes: [/* ...as above... */],
	logs: { dir: ".braid/logs", maxSizeBytes: 5 * 1024 * 1024 },
};

export default config;
```

Both fields are optional and default to the values shown above.

## Plugins

`start` always runs a loopback-only (`127.0.0.1`), bearer-token-guarded HTTP server (port + token recorded in `.braid/run.json` as `controlPort`/`controlToken`) that plugins register routes, static file serving, raw HTTP-upgrade handlers, and process lifecycle listeners on — see `PluginContext` in [`src/types.ts`](./src/types.ts). This is an internal extension point, not a public plugin marketplace: there's no auto-discovery, a plugin only runs if it's named in your config's `plugins` array.

```ts
const config = {
	processes: [/* ...as above... */],
	plugins: ["some-plugin-package", ["another-plugin", { someOption: true }]],
};

export default config;
```

A bare string entry or a `[name, options]` tuple both resolve the package (or a local `./`/`../`-relative path) from your config file's own location, so it's found in *your* `node_modules`, not braid's.

No external plugins ship yet — a web dashboard plugin is on the roadmap and will consume this same API once it exists. Core functionality (`GET /api/status`, and the per-process log capture/rotation described in [Logs](#logs)) is implemented internally the same way, compiled into `@aip-tech/braid` itself rather than published separately; it isn't configurable through `plugins` and doesn't appear in your config's `plugins` array.

## CLI

```bash
npx @aip-tech/braid start             # start every configured process as a detached background daemon
npx @aip-tech/braid status            # list each process's name/pid/alive state from the pidfile
npx @aip-tech/braid logs [name]       # print (or, with --follow, tail) a process's persisted log
npx @aip-tech/braid stop              # kill everything recorded in the pidfile, from a separate terminal
npx @aip-tech/braid start --config ./other.config.ts
```

(or just `braid ...` if installed as a dependency and run via a package.json script/`.bin`, which is how `packages/example` in this workspace uses it.)

See [`packages/example`](../example) for this wired up end to end against two toy processes, consumed exactly the way an external project would (via the built `bin`, not by reaching into `src/`).

`start` forks a detached daemon process, waits for it to confirm every process has started (a handshake over IPC, a few seconds' timeout), then returns immediately — it does not block for the lifetime of the stack, and its exit code reflects whether startup succeeded, not how the stack eventually stops. `start` refuses to run a second time while a pidfile with live PIDs already exists, and the daemon removes the pidfile once every process has exited (cleanly, via a crash, or via `stop`).

## Logs

Each configured process gets its own persistent, rotated log file at `.braid/logs/<name>.log` (raw stdout/stderr, already line-prefixed the same way the old foreground output was). The file is rotated (previous contents moved to `<name>.log.1`) whenever that process is freshly started, when a nodemon-wrapped process restarts on a file change, and as a size-based backstop once `logs.maxSizeBytes` is crossed (default 5MB) — only one backup is kept.

```bash
npx @aip-tech/braid logs               # every process, interleaved
npx @aip-tech/braid logs web           # just "web"
npx @aip-tech/braid logs web --lines 50
npx @aip-tech/braid logs web --follow  # keep streaming new output, like tail -f
```

`logs` is a thin client of an HTTP route (`GET /api/logs`) the same control server described below serves — a future web UI plugin reads through this exact same route rather than needing its own file-tailing implementation. The daemon's own diagnostic/error output (plugin failures, crash notices) is separate, in `.braid/daemon.log` — a plain file, not served over HTTP.

## Scripts

```bash
pnpm build        # tsc -> dist/, with a chmod +x on the compiled cli.js
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run
pnpm coverage     # vitest run --coverage
```

`manager.spec.ts` and `cli.spec.ts` fork real Node fixture processes under `__fixtures__/` rather than mocking `child_process` — PID tracking, kill-everything-on-crash, daemonizing, and log rotation are exactly the behavior that's easy to get subtly wrong under a mock. `cli.spec.ts` also has dedicated coverage for `isMainModule`, including the exact bin-symlink scenario a package manager creates on install (`process.argv[1]` is the symlink, `import.meta.url` resolves the real target) — a naive path comparison there silently no-ops the entire CLI. Every daemonizing test stops its daemon in `afterEach`, not only at the end of the happy path, since a detached process genuinely outlives the test if a mid-test assertion fails first.
