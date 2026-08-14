# braid

Runs multiple long-lived processes as one unit: tracks their PIDs in a pidfile, restarts individual processes via [nodemon](https://github.com/remy/nodemon) when their watched files change, and kills every process together if one of them crashes or the manager itself is stopped.

Built as a replacement for ad hoc `concurrently`/shell-script setups in monorepo `dev` scripts, where you want more than "run these commands in parallel": PID tracking you can query or kill from a separate terminal, restart-on-change for only the processes that need it, and a crash in one process taking the whole stack down together instead of leaving orphaned siblings running.

> **Status**: early-stage development. Core process management (PID tracking, nodemon-driven restarts, kill-everything-on-crash) works and is tested, the CLI is a real compiled `bin` with no TypeScript required to run it, and CI covers typecheck/lint/test/build. Not yet published to npm — a web dashboard for start/stop/status is on the roadmap.

For install instructions, config format, and CLI usage of the actual npm package, see **[packages/braid/README.md](packages/braid/README.md)**. This root README covers the workspace/monorepo itself.

## Packages

A pnpm workspace with two packages:

- [`packages/braid`](packages/braid/README.md) — the library and CLI itself, published as `@aip-tech/braid`.
- [`packages/example`](packages/example/README.md) — a live test bed: two toy processes (an HTTP server and a background worker) started via braid's actual `bin`, exactly the way an external consumer would use it.

## Setup

Requires Node 22+ and pnpm (`packageManager` is pinned in the root `package.json`).

```bash
pnpm install        # also builds packages/braid (a root `prepare` script), so its bin exists
pnpm dev            # starts packages/example's two processes via braid
pnpm dev:status
pnpm dev:stop
```

## Tooling

Shared tooling (TypeScript, Biome, Vitest, tsx) is installed once at the root and extended per package: each package has its own `tsconfig.json` (extending root `tsconfig.base.json`) and `biome.json` (extending root `biome.json`), and calls the root-installed `tsc`/`biome`/`vitest` binaries directly rather than redeclaring them as its own dependencies.

```bash
pnpm build        # compiles packages/braid's src/ to dist/
pnpm typecheck    # tsc --noEmit, across every package
pnpm format       # biome format --write, across every package
pnpm lint         # biome lint --write, across every package
pnpm check        # biome check --write, across every package (local/dev; CI runs a read-only `biome check .` instead)
pnpm test         # vitest run, across every package that defines a test script
pnpm coverage
```

Run a single package's scripts with `--filter`, e.g. `pnpm --filter ./packages/braid run test`.

## CI

`.github/workflows/ci.yml` runs on every push/PR to `main`: install, build, typecheck, a read-only Biome check, then tests.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, project layout, and what's expected before opening a PR. This project follows a [Code of Conduct](CODE_OF_CONDUCT.md). To report a security issue, see [SECURITY.md](SECURITY.md) rather than opening a public issue.
