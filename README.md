# cliproxy-dashboard

A small, clean dashboard for [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), replacing the built-in management panel.

## Dev

```sh
cp .env.example .env.local   # add your plaintext management key
npm install
npm run server               # usage server + management bridge on 127.0.0.1:5174
npm run dev                  # Vite on 127.0.0.1:5173, proxying to the server
```

The server bridges `/v0/management/*` to the running proxy (`CPA_TARGET`, default `http://127.0.0.1:8317`).
The bridge (see `server/src/http/management.ts`):

- injects the management key server-side, so it never reaches the browser bundle
- forwards only allowlisted writes unless `CPA_ALLOW_WRITES=1`
- always blocks GETs with side effects (`/usage-queue`, `*-auth-url`)
- stops forwarding after a single 401 until restart, since the proxy bans an IP for ~30 min after 5 failed key attempts

Nothing here changes the proxy itself or its config.

## Deploy

Every push to `main` publishes `ghcr.io/jarenkempton/cliproxy-dashboard:main`, then asks the deploy receiver
(`deploy/hook.ts`, behind `hooks.jarenkempton.dev/deploy`) to redeploy the TrueNAS app and waits for it.
Requests are signed with the `DEPLOY_SECRET` repo secret; the TrueNAS key stays on the server.
`deploy/compose.yaml` runs it with a Tailscale sidecar that joins the tailnet as `cliproxy-dashboard`
and serves the dashboard over HTTPS (`deploy/serve.json`). The sidecar's socket also lets the server name machines.

## Usage server

`server/` collects CLIProxyAPI's per-request usage records into SQLite (`data/usage.db`) and prices them with LiteLLM's public price table.
Bun + Hono + Drizzle.

```sh
npm run server          # run in the foreground
npm run db:generate     # after editing server/src/db/schema.ts
npm run server:check    # type-check
```

In production the same process serves the built dashboard from `dist/`.
It must be the only consumer of the proxy's usage queue: reading a record removes it.
Requires `usage-statistics-enabled: true` in the proxy config; `redis-usage-queue-retention-seconds: 3600` keeps up to an hour of records if the server is down.
