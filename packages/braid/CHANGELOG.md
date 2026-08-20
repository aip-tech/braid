# Changelog

All notable changes to `@aip-tech/braid` are documented here. Format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this
project is pre-1.0, so backwards-incompatible changes can land in a minor
version bump.

## [0.2.6] - 2026-08-20

### Added

- `beforeRestart` on a `ProcessConfig`: runs a command after a process's
  own watched files change and it's stopped, but before a fresh one
  starts - e.g. regenerating a GraphQL SDK from a schema the same
  process also watches, so the restarted process never boots against
  stale or half-regenerated output. Requires `watch`; retried like
  `onRestart`/`dependsOn.run`. If it keeps failing, the process is left
  stopped but the watcher stays active - the next matching file change
  retries the whole cycle.

### Changed

- Watch-triggered restarts no longer go through `nodemon` - braid now
  watches and restarts the process itself. Behavior is preserved for
  existing configs (same restart timing, log rotation, pid stability,
  crash detection, and default ignore list for `node_modules`/`.git`/
  etc.), but two internal details changed: the app is now killed with
  SIGTERM instead of nodemon's default SIGUSR2, and `ext` matching is a
  plain comma-separated extension check rather than nodemon's glob
  matcher (matches braid's own docs, which only ever described `ext`
  as a plain extension list). `nodemon` is no longer a dependency;
  `chokidar` (already pulled in transitively before) is now a direct
  one.

## [0.2.5] - 2026-08-20

### Added

- `foreground` config option (and `--foreground`/`--daemon` CLI flags,
  which override it per invocation): runs `start` attached to the
  terminal instead of forking a background daemon, blocking until every
  process stops and streaming their combined output straight there.

### Fixed

- A `{ processes, logs }`-shaped config's `logs` settings (log
  directory, rotation size) were silently dropped and never reached the
  daemon; the object-form config loader now actually passes them
  through.

## [0.2.4] - 2026-08-15

### Added

- `onRestart` on a `ProcessConfig`: run a command after this process
  itself restarts, e.g. rebuilding a shared workspace package other
  processes just read from, with no process of its own to restart.
  Same shape and retry behavior as `dependsOn.run`; if the process also
  has dependents, they're notified only once this hook succeeds.
- `readyPattern`/`readyTimeoutMs` on a `ProcessConfig`: hold off
  `onRestart` and any dependents' `dependsOn` cascades until a regex
  matches the process's own stdout/stderr after a restart (e.g. an
  API's "Server listening" line), not just once nodemon has re-spawned
  it. Proceeds anyway, with a logged reason, if it never matches within
  `readyTimeoutMs` (default 10s).

### Fixed

- A `dependsOn`/`onRestart` hook's own output is now line-prefixed
  (`[name] ...`) like every other process's output, instead of landing
  in the log raw and unattributed.
- `onRestart` and `dependsOn` cascades now wait for nodemon to actually
  finish restarting (its `start` event) instead of firing the instant
  nodemon decides to restart - previously a hook could run, and a
  dependent restart, while the old process was still alive and the new
  one hadn't started at all.
- A hook that keeps failing, or a `readyPattern` that never matches, is
  now logged into the relevant process's own log (visible via `braid
  logs`/`--follow`), not just `.braid/daemon.log`.

## [0.2.3] - 2026-08-15

### Added

- `dependsOn` on a `ProcessConfig`: restart a process whenever another one
  restarts, optionally running a command first (e.g. codegen) and
  retrying it until the dependency is back up. Left stopped with a
  logged reason if the hook never succeeds. A `dependsOn` graph that
  loops back on itself is rejected at startup.

### Fixed

- A `watch`ed process configured as `command: "node"` now actually
  restarts on file changes - nodemon's programmatic API silently no-ops
  on that exact shape without a separate `script` field.
- Worker→manager restart/crash messages are now tagged: nodemon
  auto-forwards its own lookalike internal events over the same IPC
  channel when forked, which could double-fire a restart and clobber a
  log's just-rotated backup.
- `package.json`'s `repository` now sets `directory: "packages/braid"`,
  so npm resolves this README's relative links (`CHANGELOG.md`,
  `src/types.ts`) against the right subdirectory instead of the repo
  root.

## [0.2.1] - 2026-08-15

### Added

- `defineConfig`, a type-safe config helper: full editor autocomplete on a
  config's default export, and fills in `logs.maxSizeBytes` when omitted.
- `@default` JSDoc on every `ProcessConfig`/`BraidConfig` field that has one.

### Changed

- READMEs trimmed to plain install/config/CLI instructions.
- Code comments trimmed throughout to short, functional notes.

## [0.2.0] - 2026-08-15

### Added

- `braid start` now runs as a detached background daemon instead of
  blocking in the foreground. It forks a daemon process, waits for an
  IPC handshake confirming every process has started, then returns
  immediately - its exit code reflects whether startup succeeded, not
  how the stack eventually stops.
- Persistent, rotated per-process log files at `.braid/logs/<name>.log`
  (raw stdout/stderr, prefixed the same way the old foreground output
  was). Rotated on every fresh `start`, on a nodemon-triggered restart,
  and as a size-based backstop (`logs.maxSizeBytes` in config, default
  5MB) - one backup kept (`<name>.log.1`).
- `braid logs [name] [--follow] [--lines n]`, reading through a new
  `GET /api/logs` route on the control server (see below) - the same
  path a future web UI will read logs through.
- An internal plugin architecture: `start` runs a loopback-only,
  bearer-token-guarded control server that both core functionality
  (`GET /api/status`, the log capture/rotation and `/api/logs` above)
  and external plugins (declared by package name in a config's new
  `plugins` array) register routes, static file serving, raw HTTP
  upgrade handlers, and process lifecycle listeners on. No plugins ship
  yet beyond the internal core ones; this is the foundation a future web
  dashboard plugin will build on.
- Config files can now default-export `{ processes, plugins, logs }`
  instead of a bare `ProcessConfig[]` array (the bare array form still
  works unchanged).

### Fixed

- `braid logs --follow` no longer hangs `stop`/shutdown - open follow
  connections are ended before the control server closes.
- `braid logs --follow` now exits cleanly (code 0) on `Ctrl-C` (SIGINT)
  or SIGTERM (which is what a script runner like pnpm sends when
  interrupting a nested script), instead of dying via the raw signal.

## [0.1.1] - 2026-08-14

### Fixed

- Publish-readiness gaps found via `npm publish --dry-run` ahead of the
  first real publish.

## [0.1.0] - 2026-08-14

Initial release, extracted from an internal monorepo and scoped under
`@aip-tech`.

### Added

- Core process supervision: forks one process per config entry, tracks
  PIDs in a pidfile, and kills every process together if one crashes
  (mirroring `concurrently --kill-others-on-fail`).
- Per-process file-watching restarts via [nodemon](https://github.com/remy/nodemon)
  (`watch`/`ext` config fields).
- CLI: `braid start` (foreground), `braid stop`, `braid status`.
- Compiled `bin`, no TypeScript tooling required to run the published
  package; CI covers typecheck/lint/test/build.
