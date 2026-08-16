# Self-hosting Goldroad

**The hosted service at [trygoldroad.com](https://trygoldroad.com) is the
recommended way to use Goldroad.** Self-hosting is possible and this document is the
one blessed path — but it is **community-supported and unsupported beyond this
document**. There is no guarantee of upgrade tooling, migration help, or backwards
compatibility for self-hosted instances. If you need something dependable, use the
hosted service.

Goldroad is AGPL-3.0-only; you are free to run your own instance. If your instance
serves other people over a network, AGPL §13 requires you to offer them the
corresponding source of the exact version you run.

## What you need

- A **Cloudflare account** (the free plan is enough to start).
- **Node.js** and **pnpm** (see `package.json` → `packageManager` for the version).
- **Wrangler** (installed as a dev dependency; commands below use `pnpm exec wrangler`).
- Your **own atproto OAuth client** — you cannot reuse ours. Every instance is its
  own confidential OAuth client, identified by *your* origin.

## One-click deploy

> Deploy to Cloudflare button — placeholder until the public repository exists:
>
> `[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/<owner>/goldroad)`

The button clones the repo into your Cloudflare account, provisions a D1 database
from `wrangler.jsonc`, rewrites the `database_id`, and prompts you for the secrets
below. You still have to set `VITE_PUBLIC_ORIGIN` and generate your OAuth key (below)
before OAuth works.

## Manual deploy

1. **Install and configure.**

   ```sh
   pnpm install
   cp .env.example .env
   cp .dev.vars.example .dev.vars
   ```

2. **Provision D1** and put its id in `wrangler.jsonc` (top-level `d1_databases[0].database_id`,
   which ships as a placeholder):

   ```sh
   pnpm exec wrangler d1 create goldroad-db
   pnpm db:migrate:selfhost    # applies drizzle/ migrations to your remote DB
   ```

   `db:migrate:selfhost` is the one to use: it carries no `--env`, so it resolves
   the top-level `d1_databases` block — the one whose id you just replaced.
   `db:migrate:prod` and `db:migrate:staging` target the hosted project's own
   environments and are not yours to run.

3. **Set your build variables.** These are `VITE_`-prefixed, which means they are
   baked into the client bundle at build time — put them in `.env` for local work
   and in your Workers Builds **build variables** for deploys, and never put a
   secret in one. The schema is `src/env.ts`; every one of them is optional there,
   but the origin is only optional in the sense that it falls back to the hosted
   instance, which is wrong for you.

   | Variable | Required | What it is |
   |----------|----------|------------|
   | `VITE_PUBLIC_ORIGIN` | yes, in practice | The origin your instance serves from, e.g. `https://your-worker.your-subdomain.workers.dev` or your own domain. Every minted URL and your OAuth `client_id` derive from it, so it must be right before the first sign-in. Left empty it defaults to the hosted origin. |
   | `VITE_PUBLIC_POSTHOG_KEY` | optional | PostHog project key. Empty (the default) means analytics never initialise at all — no SDK load, no events. |
   | `VITE_PUBLIC_POSTHOG_HOST` | optional | PostHog ingestion host. Defaults to `https://us.i.posthog.com`; set it for EU or a self-hosted PostHog. |
   | `VITE_PUBLIC_TURNSTILE_SITE_KEY` | optional | Cloudflare Turnstile sitekey. Set it and the waitlist and report forms render the widget; empty means no widget. Pair it with `TURNSTILE_SECRET` below — the sitekey alone renders a challenge nobody checks. |
   | `VITE_APP_TITLE` | optional | Overrides the application title. |

4. **Set secrets** (values documented in `.dev.vars.example`). Everything here is
   server-side and never reaches the browser:

   | Secret | Required | What it is |
   |--------|----------|------------|
   | `COOKIE_SECRET` | yes | HMAC key for the session-cookie signature. Generate with `openssl rand -hex 32`. |
   | `OAUTH_PRIVATE_KEY_JWK` | yes (prod) | ES256 private JWK for `private_key_jwt` client assertions — your instance's OAuth key. Generate it per the comment in `.dev.vars.example`. |
   | `TURNSTILE_SECRET` | optional | Turnstile secret paired with `VITE_PUBLIC_TURNSTILE_SITE_KEY`. Unset, `/api/waitlist` and `/api/report` skip verification entirely and behave as they do without Turnstile; set, a solved challenge is required. |
   | `WEBHOOK_URL` | optional | Alert webhook for the hourly cron: self-check failures, and new abuse reports awaiting triage. Absent = silent no-op: reports stay queued and unnotified, and once it is set the backlog goes out oldest-first at up to 50 per hourly tick. |
   | `POSTHOG_QUERY_API_KEY` | optional | PostHog personal API key with Query Read scope, for the writer-stats endpoint. |
   | `POSTHOG_PROJECT_ID` | optional | Numeric PostHog project id the pageviews live in. Both PostHog secrets are needed together — with either missing, `/api/stats` answers `{ enabled: false }` and never calls upstream. |

   Set each as a Worker secret, e.g.:

   ```sh
   echo "$(openssl rand -hex 32)" | pnpm exec wrangler secret put COOKIE_SECRET
   ```

5. **Deploy.**

   ```sh
   pnpm deploy
   ```

## The hourly cron is not optional

`wrangler.jsonc` declares one cron trigger (`0 * * * *`), and every scheduled job
in the app runs off it — including **scheduled publishing**. Remove the trigger
and a writer can still schedule a post; nothing will ever publish it, which is
the one failure this app works hardest to avoid. Keep the trigger, and add jobs
to `runScheduled()` in `src/lib/scheduled.ts` rather than adding triggers (the
free plan allows five per account, and one is enough).

The hour is the resolution: a post due at 09:20 goes out on the 10:00 tick. Each
tick publishes up to five due posts and leaves the rest for the next one, saying
so in its log line.

## Configuration boundaries

- The **top level** of `wrangler.jsonc` is the generic self-host target: your
  worker name, `workers_dev` on, a placeholder D1 id, and **no custom routes**. Deploy
  the top level and you get a standalone instance on your own subdomain.
- The `env.staging` / `env.production` blocks are the hosted project's own
  environments (custom domain route, specific databases). You do **not** need them;
  deploy the top level.

## Backups

Your D1 database already has 30-day point-in-time restore (Time Travel) with no
setup, which covers a bad migration or a bad delete. It does **not** survive the
database being deleted, and it cannot get a copy of your data off Cloudflare.

[`docs/BACKUPS.md`](docs/BACKUPS.md) covers both: the Time Travel commands, and
the optional nightly encrypted export that closes the rest. The export needs a
keypair and two repository secrets, so it stays off until you set it up — the
hourly cron will tell you it has no backup until then, which is the honest
answer.

## Analytics (optional)

Analytics are off unless you set `VITE_PUBLIC_POSTHOG_KEY` (PostHog). Leaving it empty
disables analytics entirely — the SDK is never even loaded.

The per-post view counts a writer sees are a separate switch: they come from PostHog's
Query API and need `POSTHOG_QUERY_API_KEY` and `POSTHOG_PROJECT_ID` as Worker secrets.
Without both, `/api/stats` reports itself disabled and the counts simply do not appear.
