# Lookglass Worker

This Cloudflare Worker exposes the Lookglass API and runs the scheduled
monitor checks. The module entrypoint delegates HTTP requests to the Hono app
and delegates Cron events to the scheduler using the event's scheduled time.

## Bindings and variables

`wrangler.jsonc` defines the following bindings:

- `DB`: the D1 database named `lookglass-db`.
- `STATUS_BUCKET`: the R2 bucket named `lookglass-status`.
- `FRONTEND_ORIGIN` and `R2_PUBLIC_BASE_URL`: non-secret Worker variables.

`ADMIN_TOKEN` and `SESSION_SECRET` are Worker secrets. Use unique, high-entropy
production values; do not use example values for a deployed Worker.

The checked-in `database_id` is intentionally the empty placeholder `""`.
Create the database first, then copy the `database_id` returned by
`npx wrangler d1 create lookglass-db` into `wrangler.jsonc`. The generated ID
must be copied before running remote migrations, Worker build validation, or
deployment. Never invent or substitute a database ID.

The checked-in `FRONTEND_ORIGIN` is the Pages default example
`https://lookglass-frontend.pages.dev`, and the checked-in
`R2_PUBLIC_BASE_URL` is the non-production example `https://status.example.com`.
Replace both with the deployed origins before production deployment.

For the Worker GitHub Actions deployment, create these repository Variables
with the exact deployed, non-secret values:

- `LOOKGLASS_D1_DATABASE_ID`: the `database_id` returned by D1 creation.
- `LOOKGLASS_FRONTEND_ORIGIN`: the exact deployed Pages origin.
- `LOOKGLASS_R2_PUBLIC_BASE_URL`: the exact public R2 custom-domain origin.

On a push to `main`, the workflow validates that all three Variables are
non-empty, safely replaces the corresponding placeholder values in the
runner-local `wrangler.jsonc`, and then runs the dry-run build and deploy.
That replacement exists only on the CI runner; it is not written back to this
repository and no real value is committed. Pull requests skip this injection
step and continue to validate against the checked-in placeholders.

Keep `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in GitHub repository
Secrets, not Variables. Keep the Worker runtime credentials `ADMIN_TOKEN` and
`SESSION_SECRET` in Wrangler/Cloudflare Secrets, not in this repository or in
GitHub Variables. The workflow never injects or prints those credentials.

For local development, copy `.dev.vars.example` to `.dev.vars` and replace the
clearly non-production token and secret placeholders with local random values.
`.dev.vars` is ignored by git.

## Local validation

Run these commands from this directory:

```bash
npm ci
npm run typecheck
npm test
npm run build
```

`npm run build` runs `wrangler deploy --dry-run`. The dry-run validates the
Worker bundle and bindings without deploying it.

## Production deployment

Before applying the commands below:

1. Run the D1 creation command and copy its generated `database_id` into the
   `LOOKGLASS_D1_DATABASE_ID` GitHub repository Variable for the main-push
   deployment. For a direct local deployment, you may replace the empty
   `database_id` in your local working copy, but do not commit it.
2. Create the `lookglass-status` R2 bucket, configure an R2 custom public
   domain for it, and set `R2_PUBLIC_BASE_URL` to that exact public origin.
   The public status object is `public/status.json`.
3. Set `LOOKGLASS_R2_PUBLIC_BASE_URL` and
   `LOOKGLASS_FRONTEND_ORIGIN` GitHub repository Variables to the exact
   deployed origins. The checked-in `r2-cors.json` contains the Pages default
   example;
   before applying it, replace `https://lookglass-frontend.pages.dev` with
   the exact deployed Pages origin and keep the single-origin `GET` rule.
4. Keep the API token and secrets out of git. The D1 ID and deployed origins
   are non-secret configuration values; GitHub Actions replaces the checked-in
   placeholders only in its runner-local copy before the main deployment. The
   two `secret put` commands prompt for values and do not place them in this
   repository.

Use this command order. Run the first seven commands from `lookglass-worker`,
then run the last three from `lookglass-frontend` after setting
`VITE_STATUS_URL` and `VITE_API_BASE_URL` to the real deployed origins:

```bash
npx wrangler d1 create lookglass-db
npx wrangler r2 bucket create lookglass-status
npx wrangler d1 migrations apply lookglass-db --remote
npx wrangler r2 bucket cors set lookglass-status --file r2-cors.json
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put SESSION_SECRET
npx wrangler deploy
npm run build
npx wrangler pages project create lookglass-frontend
npx wrangler pages deploy dist --project-name lookglass-frontend
```

The D1 `database_id` copy and R2/Pages origin replacements are required
operator actions between the listed commands; no real Cloudflare ID, domain,
API token, or secret is committed here.

## R2 CORS and static Pages data flow

`r2-cors.json` allows only `GET` from one Pages origin and exposes
`Content-Type`, `ETag`, and `Cache-Control`. Replace the checked-in Pages
default example origin with the exact deployed Pages origin before running:

```bash
npx wrangler r2 bucket cors set lookglass-status --file r2-cors.json
```

The public Pages dashboard reads `public/status.json` directly from
`R2_PUBLIC_BASE_URL`; public dashboard traffic does not go through a Worker
API route or proxy. Pages has no Functions deployment in this project.

## Frontend build variables

Set these in the frontend repository before `npm run build`. The values below
are reserved, non-production examples only; replace them with the deployed
R2 custom-domain URL and Worker origin:

```bash
export VITE_STATUS_URL="https://status.example.com/public/status.json"
export VITE_API_BASE_URL="https://worker.example.com"
```

`VITE_STATUS_URL` points to the R2 object, while `VITE_API_BASE_URL` is the
Worker origin without an API path. The CORS rule and `FRONTEND_ORIGIN` must
use the exact Pages origin that serves this build.

## Smoke checks

After both deployments, use shell-only placeholders for the deployed origins
and secret value; never put the real token in this README or in a committed
file. Verify the following sequence:

```bash
export WORKER_ORIGIN="<deployed Worker origin>"
export FRONTEND_ORIGIN="<deployed Pages origin>"
export STATUS_URL="<R2 public origin>/public/status.json"
export ADMIN_TOKEN_VALUE="<set only in this shell>"
export COOKIE_JAR="$(mktemp)"

curl --fail-with-body -H "Origin: $FRONTEND_ORIGIN" "$WORKER_ORIGIN/healthz"
curl --fail-with-body "$STATUS_URL"

curl --fail-with-body -c "$COOKIE_JAR" \
  -H "Origin: $FRONTEND_ORIGIN" \
  -H "Content-Type: application/json" \
  --data "{\"token\":\"$ADMIN_TOKEN_VALUE\"}" \
  "$WORKER_ORIGIN/api/auth/login"

curl --fail-with-body -b "$COOKIE_JAR" \
  -H "Origin: $FRONTEND_ORIGIN" \
  "$WORKER_ORIGIN/api/admin/panels"

curl --fail-with-body -b "$COOKIE_JAR" \
  -H "Origin: $FRONTEND_ORIGIN" \
  -H "Content-Type: application/json" \
  --data '{"name":"Task 10 smoke panel","logo_url":null,"sort_order":0,"enabled":true}' \
  "$WORKER_ORIGIN/api/admin/panels"

export PANEL_ID="<panel id returned above>"
curl --fail-with-body -b "$COOKIE_JAR" \
  -H "Origin: $FRONTEND_ORIGIN" \
  -H "Content-Type: application/json" \
  --data "{\"panel_id\":\"$PANEL_ID\",\"name\":\"Task 10 smoke monitor\",\"logo_url\":null,\"kind\":\"http_get\",\"target\":\"https://example.com/\",\"port\":null,\"sort_order\":0,\"enabled\":true}" \
  "$WORKER_ORIGIN/api/admin/monitors"
```

Confirm the health response is successful, the status response is valid JSON,
login returns an authenticated session cookie, panel creation returns a panel
ID, and monitor creation returns a monitor record. Because the Cron trigger is
`*/1 * * * *`, observe the next scheduled minute in Wrangler logs or the
Cloudflare dashboard and confirm the monitor check runs. The R2 snapshot is
written on the next half-hour boundary; after that boundary, fetch
`$STATUS_URL` again and confirm its `generatedAt` and monitor sample reflect
the scheduled run.
