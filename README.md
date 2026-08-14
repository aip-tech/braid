# braid

Runs multiple long-lived processes as one unit: tracks their PIDs in a pidfile, restarts individual processes via [nodemon](https://github.com/remy/nodemon) when their watched files change, and kills every process together if one of them crashes or the manager itself is stopped.

Built as a replacement for ad hoc `concurrently`/shell-script setups in monorepo `dev` scripts, where you want more than "run these commands in parallel": PID tracking you can query or kill from a separate terminal, restart-on-change for only the processes that need it, and a crash in one process taking the whole stack down together instead of leaving orphaned siblings running.

> **Status**: early. Not yet published to npm.

## Packages

A pnpm workspace with two packages:

- [`packages/braid`](packages/braid) — the library and CLI itself.
- [`packages/example`](packages/example) — a live test bed: two toy processes (an HTTP server and a background worker) run through the workspace-local `braid` source, so changes can be tried without a build or publish step.

## Setup

Requires Node 22+ and pnpm (`packageManager` is pinned in the root `package.json`).

```bash
pnpm install
pnpm dev            # starts packages/example's two processes via braid
pnpm dev:status
pnpm dev:stop
```

## Tooling

Shared tooling (TypeScript, Biome, Vitest, tsx) is installed once at the root and extended per package: each package has its own `tsconfig.json` (extending root `tsconfig.base.json`) and `biome.json` (extending root `biome.json`), and calls the root-installed `tsc`/`biome`/`vitest` binaries directly rather than redeclaring them as its own dependencies.

```bash
pnpm format   # biome format --write, across every package
pnpm lint     # biome lint --write, across every package
pnpm check    # biome check --write, across every package
pnpm test     # vitest run, across every package that defines a test script
pnpm coverage
```

Run a single package's scripts with `--filter`, e.g. `pnpm --filter ./packages/braid run test`.
