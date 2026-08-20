# Changelog

All notable changes to `@aip-tech/braid-plugin-ui` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project is pre-1.0, so backwards-incompatible changes can land in a
minor version bump.

## [0.2.2] - 2026-08-21

### Fixed

- Loading older history could leave the log pane visually blank until the
  user scrolled. `refreshVirtualizer()` asked the virtualizer to apply its
  "keep the same content in view" scroll adjustment before the pane had
  been resized for the newly-prepended lines, so the browser clamped that
  scroll to the still-old (shorter) scrollable range and the adjustment
  was silently dropped - the pane stayed scrolled to what was now a gap
  above the actual rows. The pane is now resized first. Also closed a
  related latent bug where the virtualizer's key lookup read the live
  `lines` array instead of a snapshot, which could corrupt its own
  before/after comparison across a prepend.

## [0.2.1] - 2026-08-21

### Fixed

- "Load older" history is now a button, not automatic. 0.2.0 auto-fetched
  more history whenever the log pane wasn't tall enough to scroll, so a
  quiet process's short log wouldn't strand a scroll-driven trigger with
  no scrollbar to drive it - but in real use that raced: each auto-fetch's
  prepend nudges scrollTop via the virtualizer's own anchor-preservation,
  which could refire the same automatic check before the browser settled
  the previous adjustment, corrupting the pane's layout for a process
  with real backlog, and surprising users with a dump of old history
  right on first open. Automatic loading is removed entirely (the
  scroll-driven trigger too, not just the on-open one) in favor of a
  "Load older lines" button - exactly one fetch per click.
- That button also never visually hid once history was exhausted in
  0.2.0: its own `display: block` rule tied with the `[hidden]`
  UA-stylesheet rule on specificity and won as an author style, even
  though the underlying `hidden` property was toggling correctly the
  whole time.

## [0.2.0] - 2026-08-20

### Added

- Click a process's name in the dashboard for its own page: a Stop/Restart
  toolbar plus that process's log output streaming live underneath,
  rendered with the same ANSI colors its terminal output has (via
  `ansi_up`).
- Scroll up in that log view to load further back into the process's
  history, backed by `@aip-tech/braid`'s new paginated
  `GET /api/logs/history` route - **requires `@aip-tech/braid` >=0.4.0**,
  bumped in `peerDependencies` accordingly. The log view is virtualized
  (`@tanstack/virtual-core`), so a long-lived session or a deep scroll-back
  doesn't grow the page's DOM without bound.
- Renders `@aip-tech/braid`'s new `logs.timestamps` config option (also
  requires >=0.4.0) the same as any other line content - no separate UI
  needed, it's just part of the line.

### Changed

- Dashboard layout widened (720px -> 1100px max width) to give the log
  view more room; the process table's Stop/Restart buttons now
  right-align within their column instead of sitting flush against the
  Started column at the wider width.

## [0.1.1] - 2026-08-20

### Changed

- README updated to reflect `@aip-tech/braid` 0.3.1's terminal relay:
  `braid start` now prints the dashboard's open-this-URL line directly,
  rather than only writing it to `.braid/daemon.log`. No functional
  change to this package itself - the relay is implemented entirely on
  `@aip-tech/braid`'s side.

## [0.1.0] - 2026-08-20

### Added

- Initial release: a web dashboard showing every configured process's
  name, pid, running/stopped status, and start time (polling
  `GET /api/status`), with Stop/Restart buttons per process backed by
  braid's new per-process control routes. No live log tailing yet.
- A top bar (styled like the docs site's) showing the host project's
  installed `@aip-tech/braid` version, via a new `GET /api/ui/version`
  route this plugin registers itself.
