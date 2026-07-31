# Product

What Goldroad is, who it's for, and what it will and won't do. This is the document to
read before proposing a feature — it explains which tradeoffs are already settled.

## One sentence

Goldroad is writer-owned publishing on the AT Protocol: your posts, your audience, your
name, portable forever, with 0% of reader revenue ever taken.

## The problem

Writers face a lock-in dilemma. Closed platforms provide reach, but they tax subscription
revenue, hold app-acquired followers hostage, and can remove a writer at will. Open
alternatives restore control but have no native network, so leaving means starting the
audience over.

Platform exoduses follow a consistent pattern: values trigger the switch, economics and
portability make it survivable, and lost discovery is the price. The Atmosphere is the
first open network that answers the discovery half — which is why building here resolves
a tradeoff that was previously unavoidable.

## Who it's for

1. **Writers already on Bluesky going long-form.** They have an atproto identity and an
   audience; they need a publication, not another social network. Distribution comes free
   by construction — `standard.site` records render as native cards in the timeline.
2. **Writers leaving a subscription platform.** Higher stakes: their livelihood rides on
   the migration. They arrive through `/leaving-substack` and the import tools, and they
   are the reason the money machinery has to be boring and correct before it ships.
3. **Readers**, who are served and never monetized against: calm pages, no tracking
   walls, no algorithmic feed of ours.

## Principles

These are load-bearing. A change that violates one needs to argue against the principle,
not around it.

1. **The writer owns everything.** Records in their repository, revenue in their own
   payment processor, identity in their DID. Leaving Goldroad loses nothing.
2. **Charge writer costs, never writer revenue.** The 0% take on reader payments is
   permanent positioning, not an introductory promotion. Paid plans sell costs with a
   margin — custom domains, email delivery, analytics — because those are things we
   actually pay for.
3. **The platform disappears on the writer's surfaces.** Publication and post pages carry
   the writer's identity; Goldroad's brand lives on marketing and app chrome only.
4. **Interop before invention.** Emit `site.standard.*` records. Never mint a lexicon
   where the shared one suffices — an NSID is permanent public API, so ours wait until
   the domain behind them is owned.
5. **Explain by outcome, not mechanism.** Interface copy says what the writer gets ("it
   appears as a rich card linking here"), not what the protocol does. This one was
   learned the hard way: "Announce on Bluesky" confused the first real user who saw it.
6. **The free tier is real, permanently.** A hosted publication, `standard.site`
   emission, and Bluesky distribution never sit behind a payment.

## What works today

- Sign in with an atproto identity (OAuth confidential client, DPoP + PAR).
- Write in a block editor with autosaving private drafts; publish
  `site.standard.document` records into the writer's own repository.
- Publication and post pages that render **any** atproto author's `standard.site`
  records, not only ours. Edge-cached and cookie-independent.
- Announce a post to Bluesky as a native rich card.
- RSS per publication, plus a sitemap — every publication has a machine-readable twin.
- Import an archive from Substack, Ghost, Medium, or WordPress, parsed in the browser and
  landing as private drafts.
- Export everything, or delete the account outright.
- Writer stats, honest about being approximate.
- Writer theming: four colours set in Settings, stored in the writer's own publication
  record via the shared `site.standard.theme.basic` lexicon — so a theme travels with them,
  and any author's theme is honoured on their pages here, including one set in another app.
- A dark register on every surface, and a reader's own edition switch on reading pages.

## What is not built yet

Stated plainly because the interface never claims otherwise — unshipped features are
labelled as such on marketing surfaces, never written in the present tense.

Newsletters (email delivery) · reader payments through the writer's own processor · custom
domains and subdomains · our own extension lexicon · continuous mirroring from an
existing publication · a supported self-hosting path.

## Sequence

Roughly in order, without dates: beta with founding writers → newsletters → domains and
our extension lexicon → paid subscriptions (writer as merchant of record) → the full
migration path → a self-hosting story worth supporting.

## How success is measured

Publications created, then posts published and announced. The qualitative north star
matters more than any count: **a writer who leaves says "that was easy, I kept
everything."** A platform that is painless to leave has to earn the stay, which is the
correct incentive to be under.

## Messaging

- "Publish where your readers already are."
- "Leave anytime. Lose nothing."
- "Publish on the open network, email your readers, keep 100% of what they pay you."
- Promises are stated as things the writer owns, not fears we deny — "your followers stay
  yours", not "we'll never sell your list". Naming a fear evokes it.
- Never punch sideways at other Atmosphere projects. Leaflet, pckt and Offprint are
  collaborators, and the shared lexicon is proof of it. Lock-in is the foil, not
  neighbors.
