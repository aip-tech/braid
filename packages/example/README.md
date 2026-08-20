# braid-example

A live test bed for [`braid`](../braid): five toy processes, started via braid's actual
compiled `bin`, each demonstrating a different config feature.

- `web` (`src/web.ts`) — HTTP server on port 4001. Plain `watch`, no hooks: edit and save to
  see it restart.
- `worker` (`src/worker.ts`) — logs a tick every 2 seconds. No `watch`, plain PID-tracked.
- `api` (`src/api.ts`) — HTTP server on port 4002. `watch` + `readyPattern` ("api listening")
  + `onRestart` (`src/note-restart.ts` appends to `src/restart-log.txt` after every restart of
  `api` itself, regardless of any dependents).
- `client` (`src/client.ts`) — `dependsOn` on `api`: waits for `api`'s `readyPattern` to
  actually match (not just a respawn), then its `run` hook regenerates `src/client-sdk.json`
  from `src/schema.json` before `client` restarts and reads it.
- `codegen` (`src/codegen.ts`) — `beforeRestart`: watches `src/schema.json` and its own source,
  regenerates `src/generated-sdk.json` *before* restarting (not after), so it never boots
  against a stale generated file. This is the real scenario the hook exists for - a process
  whose own restart depends on freshly regenerated output from the very change that triggered
  it.

```bash
pnpm dev             # start everything as a background daemon
pnpm watch           # ...or attached to this terminal (Ctrl-C stops everything)
pnpm dev:status      # list PIDs/alive state
pnpm dev:logs        # tail every process's output live
pnpm dev:stop        # kill everything
curl http://localhost:4001   # web
curl http://localhost:4002   # api
```

Things to try while it's running:

- Edit `src/web.ts` or `src/api.ts` and save — watch the restart in `pnpm dev:logs`.
- Edit `src/schema.json`'s `"greeting"` and save — watch `codegen` regenerate
  `generated-sdk.json` *before* its own restart, and `client` regenerate `client-sdk.json`
  once `api` next restarts.
- `cat src/restart-log.txt` after editing `src/api.ts` a few times.
