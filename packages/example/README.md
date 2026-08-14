# braid-example

A live test bed for [`braid`](../braid): two toy processes, started via braid's actual compiled `bin` (`braid start`/`stop`/`status`) through the workspace `@aip-tech/braid` dependency, exactly the way an external consumer would use it. Requires `packages/braid` to have been built at least once (`pnpm install` at the repo root does this automatically via a `prepare` script).

- `src/web.ts` — a tiny HTTP server on port 4001. Configured with `watch`, so editing it while `pnpm dev` is running restarts it via nodemon.
- `src/worker.ts` — logs a tick every 2 seconds. No `watch` set, so it demonstrates the plain PID-tracked path (still torn down with everything else on crash or `dev:stop`).

```bash
pnpm dev             # start both, from the repo root or this directory
pnpm dev:status      # list PIDs/alive state
pnpm dev:stop        # kill both, from a separate terminal
curl http://localhost:4001
```
