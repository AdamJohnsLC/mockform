# Deploy

Host: Cloudflare Workers. `wrangler.toml` sets `main = "worker.js"`, KV binding `MOCK_DB`,
and `[assets] directory = "./"` (every repo file is served as a static asset).

## Verify (no test framework in the repo)
1. `node --check worker.js && node --check app.js`
2. `npx wrangler deploy --dry-run --outdir /tmp/wbuild` — bundles the Worker and reads assets.
3. Run `npx wrangler dev --port 8787 --ip 127.0.0.1 --local` and smoke test:
   `/` , `/style.css`, `/app.js`, `/combination` return 200; `/api?sheet=Settings` 200;
   `/api?sheet=Registrations` 403 without the admin hash (by design).
   Requests that proxy to Google Apps Script fail offline (502) — that is the sandbox, not the app.

## Publish
`npx wrangler deploy` needs `CLOUDFLARE_API_TOKEN` (and account access to KV namespace
`b50116de23d643fb81b0e1ba27de8923`). Wrangler is not authenticated in this workspace, so a
deploy fails with "You are not authenticated". Save a Cloudflare token in Vault first.

## Watch out
- The harness static preview also wants port 3000; when it wins, `/api` 404s. Use another
  port for `wrangler dev`, or bind 0.0.0.0:3000 so the Worker keeps the port.
- `.wrangler/` (local KV state, ~6.5 MB) is untracked on purpose; never commit it.
