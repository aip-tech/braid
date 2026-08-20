# braid

Runs multiple long-lived processes as one unit, as a background daemon: PID tracking, watch-triggered restarts, kill-everything-on-crash, and persistent rotated per-process logs. Published on npm as `@aip-tech/braid`.

See [packages/braid/README.md](packages/braid/README.md) for install, config, and CLI usage of the package itself. This README covers the monorepo.

## Packages

- [`packages/braid`](packages/braid/README.md) — the library and CLI, published as `@aip-tech/braid` ([CHANGELOG.md](packages/braid/CHANGELOG.md)).
- [`packages/example`](packages/example/README.md) — a live test bed using braid's real built `bin`.
- [`docs`](docs/) — the documentation site, built with Vite and deployed to GitHub Pages on every push to `main`.

## Setup

Requires Node 22+ and pnpm (`packageManager` is pinned in the root `package.json`).

```bash
pnpm install        # also builds packages/braid, so its bin exists
pnpm dev            # starts packages/example via braid
pnpm dev:status
pnpm dev:logs
pnpm dev:stop
```

## Tooling

Shared tooling (TypeScript, Biome, Vitest, tsx) is installed once at the root and extended per package.

```bash
pnpm build        # compiles packages/braid's src/ to dist/
pnpm typecheck    # every package
pnpm format       # biome format --write
pnpm lint         # biome lint --write
pnpm check        # biome check --write
pnpm test         # vitest run
pnpm coverage
```

Filter to one package: `pnpm --filter ./packages/braid run test`.

## Docs site

```bash
pnpm docs:dev      # local dev server
pnpm docs:build    # static build to docs/dist
```

Deployed automatically to GitHub Pages on push to `main` via [`.github/workflows/docs.yml`](.github/workflows/docs.yml).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, project layout, and what's expected before opening a PR. Code of Conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Security issues: [SECURITY.md](SECURITY.md), not a public issue.
