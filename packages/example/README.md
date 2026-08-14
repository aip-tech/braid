# braid-example

A live test bed for [`braid`](../braid): two toy processes, wired up exactly the way a real consumer would, against the workspace-local braid source (no build/publish step needed to try changes).

- `src/web.ts` — a tiny HTTP server on port 4001. Configured with `watch`, so editing it while `pnpm dev` is running restarts it via nodemon.
- `src/worker.ts` — logs a tick every 2 seconds. No `watch` set, so it demonstrates the plain PID-tracked path (still torn down with everything else on crash or `dev:stop`).

```bash
pnpm dev             # start both, from the repo root or this directory
pnpm dev:status      # list PIDs/alive state
pnpm dev:stop        # kill both, from a separate terminal
curl http://localhost:4001
```
