# @aip-tech/braid-plugin-ui

A web dashboard for [braid](https://github.com/aip-tech/braid): live process
status, stop/restart buttons, and per-process live log tailing with
scroll-back history, served straight off braid's own control server. No
separate server, no extra port to manage - it's a `braid` plugin.

## Install

```sh
npm install --save-dev @aip-tech/braid-plugin-ui
```

Requires `@aip-tech/braid` `>=0.4.0` (the version that added the paginated
`/api/logs/history` route and `logs.timestamps` this plugin's log view
depends on).

## Use

List it in your `braid.config.ts`'s `plugins` array:

```ts
export default defineConfig({
	processes: [/* ... */],
	plugins: ["@aip-tech/braid-plugin-ui"],
});
```

Start braid as usual. `braid start` prints a line with the URL to open right
in its own terminal (needs `@aip-tech/braid` `>=0.3.1` - on an older
version, check `.braid/daemon.log` instead):

```
[plugin:ui] dashboard ready - open http://127.0.0.1:54213/?token=... in your browser
```

Open that URL once - it sets a session cookie and redirects to the plain
`http://127.0.0.1:<port>/`, so the token doesn't linger in your address bar
or history. If the daemon restarts, its token changes too; check the log
again for a fresh URL.

### Options

```ts
plugins: [["@aip-tech/braid-plugin-ui", { path: "/dashboard/" }]],
```

- `path` - URL prefix the dashboard is served under. Default `"/"`.

## What it does (and doesn't) do

Shows every configured process's name, pid, running/stopped status, and
start time, polling every 2 seconds. Stop and Restart buttons per process.
A top bar shows the host project's installed `@aip-tech/braid` version
(read from its own `package.json` at register time).

Click a process's name for its own page: the same Stop/Restart actions,
plus that process's log output streaming live underneath, rendered with
its real ANSI colors. It starts with the last 300 lines; scroll up to load
further back into the process's retained history (bounded by
`logs.maxSizeBytes` - the current file plus one rotation backup). The log
view is virtualized, so a long-lived session or a deep scroll-back doesn't
grow the page's DOM without bound.

Any plugin can stop or restart any configured process (`PluginContext.
stopProcess`/`restartProcess` - see `@aip-tech/braid`'s plugin docs), the
same trust level as any other dependency in your `node_modules`.
