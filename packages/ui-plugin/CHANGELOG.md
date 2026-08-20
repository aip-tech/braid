# Changelog

All notable changes to `@aip-tech/braid-plugin-ui` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project is pre-1.0, so backwards-incompatible changes can land in a
minor version bump.

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
