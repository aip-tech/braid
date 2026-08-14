# Contributing to braid

Thanks for taking a look. This is a small project, so the process is lightweight, but a few conventions keep it consistent.

## Setup

Requires Node 22+ and [pnpm](https://pnpm.io) (the exact version is pinned in the root `package.json`'s `packageManager` field).

```bash
git clone git@github.com:aip-tech/braid.git
cd braid
pnpm install   # also builds packages/braid via a root `prepare` script
```

`pnpm install` builds `packages/braid` automatically so its CLI `bin` exists. If you ever see `braid: command not found` after pulling changes, run `pnpm build` (or `pnpm install` again).

## Project layout

A pnpm workspace with two packages:

- `packages/braid` — the library and CLI (`@aip-tech/braid`). Source lives in `src/`; tests are colocated `*.spec.ts` files next to what they cover, not in a separate test directory.
- `packages/example` — a live test bed that runs two toy processes through braid's actual built `bin`, the same way an external consumer would.

Shared tooling (TypeScript, Biome, Vitest) is installed once at the workspace root and extended per package — see the root `README.md`'s "Tooling" section.

## Before opening a PR

```bash
pnpm build        # packages/braid: src/ -> dist/
pnpm typecheck    # tsc --noEmit, every package
pnpm check        # biome check --write, every package (or `npx biome check .` for a read-only pass matching CI)
pnpm test         # vitest run, every package that defines a test script
```

CI runs the same four steps on every push and PR; a green CI run is required before merge.

## Code style

- Formatting and linting are [Biome](https://biomejs.dev), not ESLint/Prettier. Run `pnpm format`/`pnpm lint`/`pnpm check` rather than hand-formatting.
- No unnecessary comments — code should read clearly on its own. Where a comment exists, it should explain a non-obvious *why* (a constraint, a workaround, an easy-to-miss invariant), not restate *what* the code does.
- Tests favor real behavior over mocks where practical: `packages/braid`'s tests fork real Node fixture processes under `src/__fixtures__/` rather than mocking `child_process`, since PID tracking and process-lifecycle behavior are exactly what's easy to get subtly wrong under a mock.

## Commit messages and PRs

- Keep commits focused; explain *why* a change was made, not just what changed.
- Reference an issue in the PR description if one exists.
- Small, focused PRs are easier to review than large ones bundling unrelated changes.

## Reporting bugs / requesting features

Use the issue templates under `.github/ISSUE_TEMPLATE/`. For security issues, see `SECURITY.md` instead of opening a public issue.
