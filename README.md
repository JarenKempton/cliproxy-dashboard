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
