# braid

Runs multiple long-lived processes as one unit: tracks their PIDs in a pidfile, restarts individual processes via [nodemon](https://github.com/remy/nodemon) when their watched files change, and kills every process together if one of them crashes or the manager itself is stopped.

Built as a replacement for ad hoc `concurrently`/shell-script setups in monorepo `dev` scripts, where you want more than "run these commands in parallel": PID tracking you can query or kill from a separate terminal, restart-on-change for only the processes that need it, and a crash in one process taking the whole stack down together instead of leaving orphaned siblings running.

> **Status**: early-stage development. Core process management (PID tracking, nodemon-driven restarts, kill-everything-on-crash) works and is tested, the CLI is a real compiled `bin` with no TypeScript required to run it, and CI covers typecheck/lint/test/build. Published on npm as `@aip-tech/braid` — a web dashboard for start/stop/status is on the roadmap.

## Install

```bash
npm install @aip-tech/braid
```

## Config

A config file default-exports an array of `ProcessConfig` (see [`src/types.ts`](./src/types.ts)):

```ts
import type { ProcessConfig } from "@aip-tech/braid";

const config: ProcessConfig[] = [
	{ name: "api", command: "pnpm", args: ["--filter", "./api", "run", "dev"], watch: ["api/src"] },
	{ name: "client", command: "pnpm", args: ["--filter", "./client", "run", "dev"] },
];

export default config;
```

Set `watch` (and optionally `ext`) when a process should restart on file changes; omit it when the command already manages its own reload (an internal `tsx watch`, a dev server with HMR, etc.) — that process still gets PID tracking and gets torn down with the rest, it just isn't wrapped in nodemon.

## CLI

```bash
npx @aip-tech/braid start             # run every configured process in the foreground
npx @aip-tech/braid status            # list each process's name/pid/alive state from the pidfile
npx @aip-tech/braid stop              # kill everything recorded in the pidfile, from a separate terminal
npx @aip-tech/braid start --config ./other.config.ts
```

(or just `braid ...` if installed as a dependency and run via a package.json script/`.bin`, which is how `packages/example` in this workspace uses it.)

See [`packages/example`](../example) for this wired up end to end against two toy processes, consumed exactly the way an external project would (via the built `bin`, not by reaching into `src/`).

`start` refuses to run a second time while a pidfile with live PIDs already exists, and removes the pidfile once every process has exited (cleanly, via a crash, or via Ctrl-C/`stop`).

## Scripts

```bash
pnpm build        # tsc -> dist/, with a chmod +x on the compiled cli.js
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run
pnpm coverage     # vitest run --coverage
```

`manager.spec.ts` and `cli.spec.ts` fork real Node fixture processes under `__fixtures__/` rather than mocking `child_process` — PID tracking and kill-everything-on-crash are exactly the behavior that's easy to get subtly wrong under a mock. `cli.spec.ts` also has dedicated coverage for `isMainModule`, including the exact bin-symlink scenario a package manager creates on install (`process.argv[1]` is the symlink, `import.meta.url` resolves the real target) — a naive path comparison there silently no-ops the entire CLI.
