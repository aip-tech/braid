# @aip-tech/braid-plugin-ui

A browser dashboard for [braid](https://www.npmjs.com/package/@aip-tech/braid): live status, start,
stop and restart buttons, and each process's logs. It's served by the stack itself, so there's
nothing else to run.

**[Documentation](https://aip-tech.github.io/braid/docs/ui-plugin.html)** ·
[Changelog](./CHANGELOG.md)

Requires `@aip-tech/braid` 0.10 or later and Node 22.18 or later.

## Install

```bash
npm install --save-dev @aip-tech/braid-plugin-ui
```

Add it to your `braid.config.ts`:

```ts
export default defineConfig({
	processes: [/* ... */],
	plugins: ["@aip-tech/braid-plugin-ui"],
});
```

## Open it

`braid start` prints the dashboard's link:

```
[plugin:ui] dashboard ready - open http://127.0.0.1:54213/#token=… in your browser
```

The page keeps its access token for the life of the tab, so reloading works. A new tab, or a
restarted stack, needs the link again.

## What you get

- Every process's state, pid, CPU, memory, restarts and uptime, refreshed every 2 seconds.
- Start, stop and restart buttons, using the same routes as the CLI.
- A page per process with CPU and memory charts and its live, colored log, with older lines a click
  away.

## Options

```ts
plugins: [["@aip-tech/braid-plugin-ui", { path: "/dashboard/" }]],
```

| Option | Type     | Default | Description                                                      |
| ------ | -------- | ------- | ---------------------------------------------------------------- |
| `path` | `string` | `"/"`   | URL prefix to serve the dashboard under. End it with a `/`.      |

## License

MIT
