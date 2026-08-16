# Goldroad

[![CI](https://github.com/peterkibuchi/goldroad/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/peterkibuchi/goldroad/actions/workflows/ci.yml)
[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-blue.svg)](LICENSE)

**Writer-owned publishing on the AT Protocol.** Your posts, your audience and your name
live in an account you control, so leaving costs you nothing. When reader payments ship,
our cut of them is 0% — permanently.

Live at **[trygoldroad.com](https://trygoldroad.com)** · early and building in public ·
**AGPL-3.0-only**, DCO and no CLA, so the core can never be relicensed away from the
commons. What that means in practice: [trygoldroad.com/open](https://trygoldroad.com/open).

## Why

Writers face a lock-in dilemma. Closed platforms provide reach but tax subscription
revenue, hold follower graphs hostage, and can deplatform at will. Open alternatives
restore control but have no native network. Goldroad resolves the tradeoff by building
on the [AT Protocol](https://atproto.com): posts and publications live as
[standard.site](https://standard.site) records in a repository controlled by the
writer's own decentralized identifier. Announcing one puts an enriched card in the
Bluesky timeline, rendered from the record itself rather than scraped from a link — so
the reach is real, and leaving Goldroad still costs you no work, no readers, and no
byline.

The economics follow the same principle: **we charge for writer costs (hosting, email,
domains), never writer revenue.** Reader payments — when they ship — flow through the
writer's own payment processor, whichever one serves their country. 0% platform take,
permanently.

## What works today

- Sign in with your Bluesky (atproto) identity — OAuth confidential client, DPoP + PAR,
  running on Cloudflare Workers
- Write in a block editor with autosaving private drafts; publish
  `site.standard.document` records into **your** repo
- Publication pages (`/@handle`) and document pages for **any** atproto author's
  standard.site records, not just ours
- Announce posts to Bluesky as native rich cards
- RSS per publication, plus a sitemap
- Import an archive from Substack, Ghost, Medium or WordPress — parsed in your browser,
  landing as private drafts
- Read the conversation: replies to a post's Bluesky announcement render under the post
  itself, so the network is the comment section
- Schedule a post for later; the queue says plainly whether it went out, and why not
- Set your publication's colours — stored in your own record, so other apps on the
  network render your page in them too
- Readers can subscribe to a publication, and choose light or dark for themselves
- Writer stats (followers over time, per-post engagement), honest about being approximate
- Export everything, or delete your account outright
- An hourly self-check of core invariants in production, backed by external uptime
  monitoring, and an adversarially-reviewed pipeline

Newsletters, reader payments, custom domains, our own extension lexicon
and continuous mirroring are **not** built yet — [`docs/PRODUCT.md`](docs/PRODUCT.md)
lists exactly what's shipped and what isn't. Self-hosting is documented
([`SELF_HOSTING.md`](SELF_HOSTING.md)) but community-supported, not a product yet.

## How it's checked

`pnpm gate` is the whole ladder behind one exit code — lint with warnings fatal, then
typecheck, then the test suite — and it runs on every pull request. The suite leans on
behaviour rather than implementation: what a handler writes and in what order, what it
leaves alone when a step fails, and the honesty rules (an absent number is never
rendered as a zero).

An hourly Workers cron re-checks core invariants against the live origin and the
freshness of the nightly off-platform database export, and tells a human about abuse
reports nobody has triaged yet. If you self-host, set `WEBHOOK_URL` and it posts there;
without it the checks still run and log, which is quieter than you probably want
(`src/lib/scheduled.ts`).

## Stack

TanStack Start · React 19 · Tailwind v4 · Cloudflare Workers + D1 · Drizzle ·
[@atcute](https://github.com/mary-ext/atcute) · BlockNote. Stack constraints,
conventions, and the contribution gate live in [`AGENTS.md`](AGENTS.md); see
[`CONTRIBUTING.md`](CONTRIBUTING.md) to get started and [`SELF_HOSTING.md`](SELF_HOSTING.md)
to run your own instance.

## Docs

- [`docs/PRODUCT.md`](docs/PRODUCT.md) — what this is for, which tradeoffs are settled,
  what's shipped and what isn't. Read before proposing a feature.
- [`docs/DESIGN.md`](docs/DESIGN.md) — the two-surface visual system, tokens, and voice.
  Read before touching UI.

## Develop

```sh
pnpm install
cp .env.example .env && cp .dev.vars.example .dev.vars   # fill per the comments
pnpm dev    # browse at http://127.0.0.1:3000 (not localhost — OAuth loopback rules)
pnpm check && pnpm typecheck && pnpm test                # the gate; keep it green
```

## Licensing

- Server/core: **AGPL-3.0-only** ([LICENSE](LICENSE)). Anyone running Goldroad as a
  service for other people — this project included — owes those people the source of
  the exact version they're using.
- Lexicons, if we ever need one of our own: **CC0**. Today we publish into the shared
  `site.standard.*` vocabulary and haven't minted any.
- Client SDK, when one exists: **MIT**, so native clients can build on it without the
  copyleft. There isn't one yet.

Contributions are accepted under the **DCO** (`git commit -s`), with **no CLA**. That is
the mechanism, not just the intent: without a CLA no single party holds enough copyright
to relicense the core away from the commons.

## Acknowledgments

The [standard.site](https://standard.site) lexicon by the Leaflet, pckt.blog and
Offprint teams; [atcute](https://github.com/mary-ext/atcute) by mary-ext; and the wider
Atmosphere's collaborate-over-compete culture, which this project intends to honor.
