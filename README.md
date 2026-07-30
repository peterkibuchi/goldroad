# Goldroad

**Writer-owned publishing on the AT Protocol.** Your posts, your audience, your name —
portable forever, with 0% of reader revenue ever taken.

Live at **[trygoldroad.com](https://trygoldroad.com)** · early and building in public.

## Why

Writers face a lock-in dilemma. Closed platforms provide reach but tax subscription
revenue, hold follower graphs hostage, and can deplatform at will. Open alternatives
restore control but have no native network. Goldroad resolves the tradeoff by building
on the [AT Protocol](https://atproto.com): posts and publications live as
[standard.site](https://standard.site) records in a repository controlled by the
writer's own decentralized identifier — Bluesky renders them natively in the timeline —
so leaving Goldroad never means losing your work, your readers, or your byline.

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
- Export everything, or delete your account outright
- A 27-check production canary, 1,087 tests, and an adversarially-reviewed pipeline

Newsletters, reader payments, custom domains and continuous mirroring are **not** built
yet — [`docs/PRODUCT.md`](docs/PRODUCT.md) lists exactly what's shipped and what isn't.

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

- Server/core: **AGPL-3.0-only** ([LICENSE](LICENSE))
- Lexicons (when published): **CC0**
- Client SDK (future): **MIT**

Contributions via **DCO** (sign-off), no CLA — the core can never be relicensed away
from the commons.

## Acknowledgments

The [standard.site](https://standard.site) lexicon by the Leaflet, pckt.blog and
Offprint teams; [atcute](https://github.com/mary-ext/atcute) by mary-ext; and the wider
Atmosphere's collaborate-over-compete culture, which this project intends to honor.
