# cliproxy-dashboard

A small, clean dashboard for [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), replacing the built-in management panel.

## Dev

```sh
cp .env.example .env.local   # add your plaintext management key
npm install
npm run dev
```

The dev server bridges `/v0/management/*` to the running proxy (`CPA_TARGET`, default `http://localhost:8317`).
The bridge (see `vite.config.ts`):

- injects the management key server-side, so it never reaches the browser bundle
- forwards only GET requests unless `CPA_ALLOW_WRITES=1`
- always blocks GETs with side effects (`/usage-queue`, `*-auth-url`)
- stops forwarding after a single 401 until restart, since the proxy bans an IP for ~30 min after 5 failed key attempts

Nothing here changes the proxy itself or its config.

## Usage server

`server/` collects CLIProxyAPI's per-request usage records into SQLite (`data/usage.db`) and prices them with LiteLLM's public price table.
Bun + Hono + Drizzle.

```sh
npm run server          # run in the foreground
npm run db:generate     # after editing server/src/db/schema.ts
npm run server:check    # type-check
```

It runs permanently under launchd (`server/launchd/dev.cliproxy.usage-server.plist`, logs in `data/server.log`).
It must be the only consumer of the proxy's usage queue: reading a record removes it.
Requires `usage-statistics-enabled: true` in the proxy config; `redis-usage-queue-retention-seconds: 3600` keeps up to an hour of records if the server is down.
