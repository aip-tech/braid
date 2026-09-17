# Changelog

All notable changes to `@aip-tech/braid` are documented here. Format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this
project is pre-1.0, so backwards-incompatible changes can land in a minor
version bump.

## [0.9.4] - 2026-09-18

### Fixed

- `braid stop`/a `dependsOn` cascade/daemon shutdown could leave a
  process's real OS process running forever if it traps or ignores
  `SIGTERM`, instead of eventually SIGKILLing it as documented. The
  outer worker fork installs no `SIGTERM` handler of its own, so it
  always died near-instantly regardless of what its inner app did -
  `stopChild`'s SIGKILL-escalation timer was watching the fork's exit,
  not the inner app's, so it effectively never fired for this case; and
  even when it did, `tree-kill` can no longer reach an already-orphaned
  child once its former parent (the fork) has already exited, since it
  walks live `ppid` relationships at call time. Fixed by giving the
  worker fork its own `SIGTERM` handler that kills its inner app first
  (reusing the same kill/wait/SIGKILL-escalate sequence a watch-triggered
  restart already had) and only exits once that's confirmed done -
  `stopChild`'s own wait on the fork's exit is accurate again as a
  result, with a widened outer backstop timeout so it acts as a true
  last-resort rather than racing and winning against the fork's own,
  now-real internal escalation.

## [0.9.3] - 2026-09-17

### Added

- `ProcessConfig.autoRestart?: boolean` (@default `false`): when a process
  exits with a non-zero code, restart just that process instead of
  stopping the whole stack the way an unhandled crash does by default.
  Retries with exponential backoff (`restartDelayMs`, doubling each
  attempt, capped at 10s) up to `maxRestarts` consecutive failures
  (@default `10`) before falling back to today's stop-everything
  behavior; `minUptimeMs` (@default `1000`) resets the failure count once
  a restart stays up long enough to count as recovered, so an occasional
  crash after hours of uptime doesn't count against a real crash loop.
  Implemented entirely in `worker.ts`, reusing the exact same
  `"restart"`/`"started"` IPC message pair a `watch`-triggered restart
  already sends - `manager.ts` needed no changes at all, since it already
  treats every restart identically regardless of what triggered it. This
  also means a crash-triggered auto-restart runs `onRestart` and cascades
  to `dependsOn` dependents exactly like any other restart, once per
  attempt - deliberate, for consistency, though a crash loop will re-run
  a heavy `onRestart` hook more than once as a result.

## [0.9.2] - 2026-09-17

A full push to close every remaining test-coverage gap in the package,
starting from `worker.ts` and `daemon.ts` (the two per-process/per-daemon
entrypoints forked at runtime, both at 0% measured coverage - only
exercised indirectly through `manager.spec.ts`/`cli.spec.ts` forking a
real subprocess, invisible to istanbul since coverage is only collected
inside the vitest worker process itself) and continuing through every
other file with a gap. **Statement, branch, function, and line coverage
are now all 100%** (up from 79%/73%/76%/81% respectively). Writing direct
tests for `manager.ts`'s dependency-cascade logic surfaced a real bug,
fixed below.

### Fixed

- A process with both `dependsOn` and its own still-pending `startAfter`
  chain could be force-spawned early if the `dependsOn` dependency
  restarted before the `startAfter` chain resolved, then spawned *again*
  once that chain actually completed - leaking the first process entirely
  (untracked, and never killed even on daemon shutdown, since nothing kept
  a reference to it once `children` was overwritten by the second spawn).
  Reproduced directly before fixing: a real orphaned `worker.ts` process
  was left running after a full, clean `stopFromPidfile`. `restartDependent`
  now leaves a still-pending dependent alone; `ensureReady` already owns
  its first spawn and delivers it once actually ready, exactly like a
  manual first start doesn't cascade either.
- `control-server.ts`'s static-file routing (`registerStatic`) now matches
  the *longest* registered prefix, not whichever entry happened to be
  registered first (a broader prefix like a UI plugin's default `/` mount
  could previously shadow every path, including one meant for a more
  specific prefix a second plugin registered afterwards).
- `GET /api/logs/history`'s pagination cursor could resolve to the wrong
  file when a process's log file already existed from a previous daemon
  run and a history request landed before that process had emitted any
  output yet this run - see the full explanation in this same entry's
  predecessor version below. Fixed by counting the lazy rotation as a
  generation bump.

### Changed

- `cli.ts`'s `runCli` dispatch `switch` no longer holds each command's
  full implementation inline - `start`/`logs`/`stop`/`restart`/`status`
  are now separate, individually named functions, each taking just the
  arguments it needs. `startDaemon` is now exported so its ready/error/
  exit/fork-error/timeout race can be driven directly with `fork()`
  mocked, in a new `start-daemon.spec.ts` - those are rare-failure-mode
  and timing paths a real forked daemon can't be driven into
  deterministically from a test.
- `worker.ts`'s `loadConfig`, `daemon.ts`'s `loadInput`/`send`/`main`, and
  `manager.ts`'s `stopChild`/`findRunningPidfile` are now exported
  (previously module-private) so they can be unit-tested directly.
  `daemon.ts`'s fatal-startup-error handling is now its own exported
  `reportStartupFailure` function instead of being inlined into the
  top-level `main().catch(...)` glue. `worker.ts`'s tuning constants
  (`RESTART_DEBOUNCE_MS`, `DEFAULT_HOOK_RETRIES`,
  `DEFAULT_HOOK_RETRY_DELAY_MS`, `DEFAULT_STOP_TIMEOUT_MS`,
  `DEFAULT_EXT`) are exported too, so tests can drive fake-timer
  assertions off the exact values in use instead of duplicating them.
- `core-plugins/processes.ts`'s three routes each repeated the same "read
  `?name=`, 400 if missing" check inline; extracted into one shared
  `requireNameParam` helper.
- Removed `killTree`'s unused `signal` default (`= "SIGTERM"`) - dead code
  once actually checked: both call sites always pass an explicit signal,
  unlike `manager.ts`'s equivalent `killPid`, whose default genuinely has
  callers relying on it.
- A number of genuinely unreachable defensive branches (an IPC message
  shape worker.ts's own protocol never sends, `req.url`/`req.method`
  fallbacks Node's HTTP parser never leaves unset, a `fork()`-level error
  event forking this same Node executable essentially can't produce, and
  a few others) are now marked with `istanbul ignore` and a comment
  explaining why, rather than left silently uncovered or covered by a
  contrived test that doesn't correspond to any real code path.

### Added

- `worker.spec.ts`, `daemon.spec.ts`, `module-path.spec.ts`,
  `manager-stop-child.spec.ts`, `start-daemon.spec.ts`,
  `core-plugins/processes.spec.ts` (all new): direct, mocked-dependency
  unit tests for the pieces above, each verified against real observable
  output (spawn/kill calls, IPC messages, stdout/stderr writes, exit
  codes, HTTP responses) rather than just call counts.
- `manager.spec.ts` gained substantially more coverage of `runManager`'s
  own orchestration: `options.plugins` validation, per-process/hook `cwd`
  resolution, `logs.timestamps`, concurrent stop/restart/start
  interactions (including the watch-vs-manual-restart lock race and the
  dependent-leak regression above), a `pidusage` polling-failure mock
  extension (dropped pids, forced Error/non-Error rejections), and several
  "a real shutdown begins mid-operation" races (SIGINT twice, two crashes
  at once, shutdown during a slow `dependsOn` hook/readyPattern wait).
- `control-server.spec.ts`, `core-plugins/logger.spec.ts`, and
  `plugin-loader.spec.ts` gained coverage of their own remaining edge
  cases: static-file serving (bare prefix, 404, unknown MIME type),
  cookie parsing, route-handler error formatting, `/api/logs/history`'s
  backup-file fallback and stale-cursor paths, and a plugin module
  throwing a non-`Error` value at import time.

## [0.9.1] - 2026-09-17

A round of in-depth code review focused on correctness edge cases and
maintainability, plus real test coverage for the two `core-plugins` routes
that previously had none of their own (`processes.ts` had no dedicated
spec file at all; `logger.ts`'s `/api/logs/history` route was entirely
untested).

### Fixed

- `control-server.ts`'s static-file routing (`registerStatic`) now matches
  the *longest* registered prefix, not whichever entry happened to be
  registered first. A broader prefix (e.g. `@aip-tech/braid-plugin-ui`'s
  default `/` mount) could previously shadow every path, including one
  meant for a more specific prefix a second plugin registered afterwards -
  `url.pathname.startsWith(entry.prefix)` is true for both, and `.find()`
  always returned the first, order-dependent match.
- `GET /api/logs/history`'s pagination cursor could resolve to the wrong
  file (silently returning unrelated content, or too little of it) when a
  process's log file already existed from a previous daemon run and a
  history request landed before that process had emitted any output yet
  this run. The lazy `Destination` created on that first output rotates
  the leftover file into `.1`, but started its own generation counter back
  at 0 - indistinguishable from a cursor minted moments earlier against
  the (now-rotated) stale file, which also read as generation 0 via the
  no-`Destination`-yet fallback. The lazy rotation now counts as a
  generation bump, so an earlier cursor correctly re-targets into the
  backup file instead of comparing equal to the unrelated fresh one.

### Changed

- `cli.ts`'s `runCli` dispatch `switch` no longer holds each command's
  full implementation inline - `start`/`logs`/`stop`/`restart`/`status`
  are now separate, individually named functions (`runStartCommand`,
  `runLogsCommand`, etc.), each taking just the arguments it needs.
  Behavior is unchanged; this is purely about keeping each command a
  small, independently readable/testable unit instead of one large
  multi-hundred-line `switch`.
- `core-plugins/processes.ts`'s three routes each repeated the same
  "read `?name=`, 400 if missing" check inline; extracted into one shared
  `requireNameParam` helper.

### Added

- A dedicated `core-plugins/processes.spec.ts` covering all three
  `/api/processes/*` routes directly (previously only exercised
  indirectly through `manager.spec.ts`'s end-to-end tests, which never
  happened to hit the missing-`name` 400 path).
- `core-plugins/logger.spec.ts` now covers `GET /api/logs/history`:
  basic pagination, paging across a rotation boundary, a cursor stale by
  more than one generation, and a regression test for the cursor bug
  above.
- `control-server.spec.ts` now covers the longest-prefix-match fix above.

## [0.9.0] - 2026-09-17

A batch of fixes from a full code-security/quality review of the package.

### Added

- `stopTimeoutMs?: number` on `ProcessConfig` — how long to wait after
  sending SIGTERM (to a process's whole tree) before escalating to SIGKILL.
  Applies to every stop of that process: a manual `stop`/`restart`, a
  `dependsOn` cascade, a watch-triggered restart, and daemon shutdown.
  @default 5000
- `--no-watch` flag on `start` — ignores every process's `watch` (and
  `beforeRestart`, which requires it) for that one run, without touching
  the config file. Manual `restart <name>`, `dependsOn` cascades, and
  `onRestart` hooks are unaffected; only the watch-triggered restart path
  is disabled.

### Fixed

- A process that ignores or doesn't forward SIGTERM (a wrapper script, or
  one that traps it) no longer hangs `stop`/`restart`/shutdown forever —
  `stopChild` (and the worker's own watch-triggered restart) now escalate
  to SIGKILL after `stopTimeoutMs`.
- An invalid `readyPattern` regex (a typo like `"("`) is now rejected at
  startup with a clear error, instead of surfacing later as an unhandled
  rejection that crashes the whole daemon on that process's first restart.
- The control server's bearer/cookie/query token is now compared with a
  constant-time check (`crypto.timingSafeEqual`) instead of `===`, so a
  local attacker able to send many timed requests can't recover it
  byte-by-byte from response-timing differences.
- The pidfile (`.braid/run.json`, which carries that same control-server
  token) and its directory are now written with owner-only permissions
  (`0o600`/`0o700`) instead of inheriting the process umask — on a shared
  host, another local user could previously just read the token off disk.
- A route handler error is no longer echoed back to the HTTP client
  verbatim; it's logged server-side instead, and the client gets a generic
  "Internal error" — defense-in-depth against leaking internal detail
  (paths, module names) to anyone who does obtain the token.
- A dependency-cascaded restart (via `dependsOn`) now runs the restarted
  process's own `readyPattern` wait and `onRestart` hook before notifying
  its own dependents in turn, exactly like a direct restart does. Fixes a
  multi-hop chain (`grandchild -> client -> api`) cascading to `grandchild`
  the instant `client` respawns, instead of waiting on `client`'s own
  readiness/hook first.
- CPU/memory stats no longer briefly show a restarted process's
  predecessor's values when a `pollStats()` tick's `pidusage()` call is
  still in flight at the moment of the restart.
- Two processes sharing the same `name` are now rejected at startup,
  instead of both being spawned with every by-name operation (stop,
  restart, the per-process log file) silently resolving to only one of
  them.
- `GET /api/logs?name=` (an explicit but empty value) now behaves exactly
  like an omitted `name` for a `follow=true` request - it used to register
  the connection under a follower key nothing ever dispatches to, leaving
  it open and silently inert until the daemon shut down.
- A raw HTTP Upgrade (`registerUpgrade`) can now authenticate via the same
  session cookie a normal GET already can, not just a `?token=` query
  param - lets a future WebSocket-using plugin avoid keeping the bearer
  token in reach of page JS just for that one request.
- The CLI's config loader now rejects a process missing a `name`/`command`
  string with a clear, per-entry error at startup instead of that surfacing
  later as an obscure failure inside a freshly-forked worker, and wraps a
  config file that throws at import time in a clear message instead of
  propagating the raw thrown value.
- `braid start --foreground`'s log auto-follow now reports a non-ok
  response from the control server instead of silently doing nothing.

## [0.8.0] - 2026-09-15

### Added

- `exclude?: string[]` on `ProcessConfig` — paths to leave out of `watch`,
  resolved the same way `watch` entries are. Useful for a generated-code
  directory living inside an otherwise-watched folder, so regenerating it
  doesn't trigger its own restart. Each entry excludes itself and its
  whole subtree; a glob is also accepted. Only used when `watch` is set.

## [0.7.0] - 2026-09-15

### Added

- `autoStart: false` on `ProcessConfig` — keep a process from forking when
  `start` boots the whole stack; it stays fully configured (shown by
  `status`/the dashboard as "not started") until started on demand via
  `braid start <name>`, the dashboard's Start button, or
  `PluginContext.startProcess()`. Starting an already-running process is a
  safe no-op. Rejected at startup if combined with a non-empty `dependsOn`
  on the same process, or if named as another process's `startAfter`
  target — both would force-start it before anyone asked. See
  [Starting on demand](./README.md#starting-on-demand).
- `braid start <name>` — starts one configured process inside an
  already-running daemon, the counterpart to the existing
  `stop <name>`/`restart <name>`.
- New `POST /api/processes/start` control-server route and
  `PluginContext.startProcess(name)`.

### Changed

- `PluginContext.getProcesses()` (and so `GET /api/status`) now includes
  every *configured* process, not only ones that have run at least once —
  a never-started `autoStart: false` process shows up with `pid`/
  `startedAt` absent and `alive: false`. `startedAt` is correspondingly
  optional now on that return type; every other field is unchanged.

## [0.6.0] - 2026-09-14

### Added

- `startAfter: { processes }` on `ProcessConfig` - don't fork a process for
  the first time until the named processes are themselves ready (their own
  `readyPattern` has matched, or immediately if they set none). Only
  affects each process's very first spawn; later watch-triggered/
  `dependsOn`/manual restarts are unaffected, and `start` doesn't block on
  a slow `startAfter` chain before returning. A chain that loops back on
  itself is rejected at startup, same as a circular `dependsOn`. See
  [Waiting to start](./README.md#waiting-to-start).

## [0.5.0] - 2026-08-21

### Added

- Per-process CPU/memory sampling via `pidusage`, polled every
  `statsPollIntervalMs` (new `BraidConfig` option, `@default 2000`) and
  surfaced as optional `cpu`/`memory` fields on
  `PluginContext.getProcesses()` - so `GET /api/status` (and anything
  that already reads it, e.g. `@aip-tech/braid-plugin-ui`'s dashboard)
  gets them for free. `braid status` also shows a `cpu X.X% mem Y MB`
  suffix per process when the daemon is reachable, falling back to
  today's plain pidfile-only output otherwise.

## [0.4.0] - 2026-08-20

### Added

- `GET /api/logs/history?name=&before=&lines=` - paginated access to a
  process's older log history, beyond what the existing `follow=true`
  tail replays. Returns `{ lines, cursor }`; `cursor` is an opaque
  `<current|backup>:<generation>:<lineIndex>` token, round-tripped via
  `before` to page further back. Reads only the current log file and its
  one rotation backup (each capped at `logs.maxSizeBytes`), and
  correctly re-targets a cursor into the renamed backup file if a
  rotation happens between calls, rather than serving stale content.
  Backs `@aip-tech/braid-plugin-ui`'s new scroll-to-load-older history in
  its per-process log view.
- `logs.timestamps` config option (`@default false`) - prepends a dimmed
  `HH:MM:SS.mmm` to every log line. Applied once, in `prefix.ts`'s
  `linePrefixer`, so the log file, `braid logs`, `@aip-tech/braid-plugin-ui`,
  and the terminal during `braid start` all get the exact same
  timestamped bytes - there's no way to enable it in just one of them.

## [0.3.1] - 2026-08-20

### Added

- `PluginContext.log()` now also relays the message to the CLI's own
  terminal when `start` daemonizes, in addition to `daemon.log` - but
  only if sent before the daemon's "ready"/"error" handshake, since the
  CLI disconnects that IPC channel right after. In practice this means a
  plugin's `controlServerReady` handler (e.g. `@aip-tech/braid-plugin-ui`
  announcing its dashboard URL) now shows up right in the terminal that
  ran `braid start`, not only in `daemon.log`.

## [0.3.0] - 2026-08-20

### Added

- `braid stop <name>` and `braid restart <name>`: per-process stop/restart,
  backed by two new control-server routes (`POST /api/processes/stop` and
  `POST /api/processes/restart`, both `?name=<name>`) and two new
  `PluginContext` methods, `stopProcess(name)`/`restartProcess(name)`,
  available to any plugin. `restart` reuses the exact same
  readyPattern-wait/`onRestart`-hook/`dependsOn`-cascade sequence a
  watch-triggered restart gets. Stopping the last process manually leaves
  the daemon running (so it can still be restarted later) instead of
  auto-shutting-down the way an unprompted "every process has exited"
  does.
- A new `controlServerReady` lifecycle event (`{ port, token }`), fired
  once the control server is listening and every plugin has finished
  `register()`'ing - lets a plugin serving browser content construct and
  log a URL pointing at itself, which `register()` itself can't do (the
  port isn't known yet at that point).
- The control server now accepts a one-time `?token=` query param as well
  as the `Authorization` header, so a plain browser navigation (which
  can't send a custom header) can load a plugin's static content. The
  first request authenticated this way gets a port-scoped session cookie
  and, for a GET, a redirect that strips the token back off the visible
  URL - the browser's own subsequent `fetch()` calls then authenticate via
  that cookie automatically.

### Changed

- `start`'s "running in foreground"/"started" banners, and every other
  CLI message that used to read `braid: ...`, now carry the same
  `[braid]` tag as `emitDiagnostic`/plugin-loader messages instead of a
  plain `braid:` prefix - one consistent style for "this is braid
  talking," not two. `[braid]` and `[plugin:x]` tags also render in a
  fixed gray, distinguishing them at a glance from each process's own
  colored `[name]` log lines when they're interleaved in the same
  terminal (most visibly under `--foreground`) - though the tag itself is
  the load-bearing part in a terminal that doesn't render ANSI color.

- `braid stop <name>` previously silently ignored the name and stopped
  everything; it now stops only that process (see above).

## [0.2.9] - 2026-08-20

### Changed

- README example paths cleaned up (no functional change).

## [0.2.8] - 2026-08-20

### Fixed

- A `braid start --foreground` shutdown could take a stray ~2 extra
  seconds to actually exit (`SHUTDOWN_EVENT_TIMEOUT_MS`) even after
  every process had already stopped - the `setTimeout` backing that
  race's fallback branch was never cleared once the race resolved via
  the other branch, so the still-pending timer kept the event loop (and
  the whole process) alive until it eventually fired on its own.
  Invisible in a daemonized `start` (the CLI already returns before
  this ever runs) and in tests (`runManager` runs alongside an
  already-busy test-runner event loop) - only a standalone
  `--foreground` process's own natural exit was ever actually blocked
  by it.

## [0.2.7] - 2026-08-20

### Added

- A process now logs `braid: stopping` (or `braid: stopping (dependency
  restarted)`/`braid: stopping (restarting)`) into its own log right
  before braid stops it for a `dependsOn` cascade or a watch-triggered
  restart, so `braid logs`/`--follow` shows a clear marker instead of
  the log just going quiet. Not yet emitted for a plain `braid stop`
  (the CLI stops each process directly rather than asking the running
  daemon to shut down gracefully).

### Fixed

- A `braid start --foreground` shutdown could be aborted mid-flight (a
  raw, unhandled SIGINT/SIGTERM killing the process instead of exiting
  cleanly) if a second Ctrl-C landed while several processes were still
  being stopped - the signal handler was removed as soon as shutdown
  began, so a repeat signal in that window fell through to Node's
  default disposition instead of being safely ignored.
- `core:logger` no longer throws (and logs a spurious "lifecycle
  listener failed" warning) if a still-running process's own output
  arrives in the brief window after `daemonShutdown` already closed its
  log stream.
- A crash-triggered shutdown could misreport the very process that
  crashed as having been stopped by braid, rather than having crashed -
  its own exit hadn't been detected yet at the moment the check ran.

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
