# braid

Runs multiple long-lived processes as one unit: tracks their PIDs in a pidfile, restarts individual processes via [nodemon](https://github.com/remy/nodemon) when their watched files change, and kills every process together if one of them crashes or the manager itself is stopped.

Built as a replacement for ad hoc `concurrently`/shell-script setups in monorepo `dev` scripts, where you want more than "run these commands in parallel": PID tracking you can query or kill from a separate terminal, restart-on-change for only the processes that need it, and a crash in one process taking the whole stack down together instead of leaving orphaned siblings running.

> **Status**: early, extracted from an internal monorepo. Not yet published to npm.

## Config

A config file default-exports an array of `ProcessConfig` (see [`src/types.ts`](./src/types.ts)):

```ts
import type { ProcessConfig } from "braid";

const config: ProcessConfig[] = [
	{ name: "api", command: "pnpm", args: ["--filter", "./api", "run", "dev"], watch: ["api/src"] },
	{ name: "client", command: "pnpm", args: ["--filter", "./client", "run", "dev"] },
];

export default config;
```

Set `watch` (and optionally `ext`) when a process should restart on file changes; omit it when the command already manages its own reload (an internal `tsx watch`, a dev server with HMR, etc.) — that process still gets PID tracking and gets torn down with the rest, it just isn't wrapped in nodemon.

## CLI

```bash
tsx src/cli.ts start             # run every configured process in the foreground
tsx src/cli.ts status            # list each process's name/pid/alive state from the pidfile
tsx src/cli.ts stop              # kill everything recorded in the pidfile, from a separate terminal
tsx src/cli.ts start --config ./other.config.ts
```

See [`packages/example`](../example) for this wired up end to end against two toy processes.

`start` refuses to run a second time while a pidfile with live PIDs already exists, and removes the pidfile once every process has exited (cleanly, via a crash, or via Ctrl-C/`stop`).

## Scripts

```bash
pnpm test         # vitest run
pnpm coverage     # vitest run --coverage
```

`manager.spec.ts` and `cli.spec.ts` fork real Node fixture processes under `__fixtures__/` rather than mocking `child_process` — PID tracking and kill-everything-on-crash are exactly the behavior that's easy to get subtly wrong under a mock.

## Remaining before a v1 npm publish

- A proper `bin` entry: the CLI currently runs via `tsx cli.ts`, which works for a workspace consumer with `tsx` installed, but a published package needs either a compiled JS bin with a shebang, or a bundled single-file CLI.
- A build step (the source ships as raw TypeScript today, fine inside a pnpm workspace that already runs everything through `tsx`, not fine as a published artifact).
- CI (lint/typecheck/test on push).
