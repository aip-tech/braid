# braid-example

A live test bed for [`braid`](../braid): two toy processes, started via braid's actual compiled `bin`.

- `src/web.ts` — HTTP server on port 4001. `watch` set, restarts via nodemon on save.
- `src/worker.ts` — logs a tick every 2 seconds. No `watch`, plain PID-tracked.

```bash
pnpm dev             # start both as a background daemon
pnpm dev:status      # list PIDs/alive state
pnpm dev:logs        # tail both processes' output live
pnpm dev:stop        # kill both
curl http://localhost:4001
```
