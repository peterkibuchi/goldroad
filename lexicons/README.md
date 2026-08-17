# Lexicons

<!-- SPDX-License-Identifier: CC0-1.0 -->

Goldroad's own AT Protocol lexicon schemas. **These files are dedicated to the public
domain under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/legalcode)**,
deliberately and separately from the AGPL-3.0-only licence that covers the rest of this
repository (see the root [`LICENSE`](../LICENSE)). A vocabulary that other people cannot
freely implement is not a vocabulary; copyleft belongs on the server, not on the words.

`SPDX-License-Identifier: CC0-1.0`

## What's here

| NSID | Purpose |
| --- | --- |
| [`pub.goldroad.content.markdown`](pub/goldroad/content/markdown.json) | Markdown body for a `site.standard.document`, as an entry in that record's open `content` union. |

Almost everything Goldroad writes uses the shared [standard.site](https://standard.site)
vocabulary — `site.standard.document`, `site.standard.publication`,
`site.standard.theme.basic`, `site.standard.graph.subscription` — and that is the
intended state. A schema only lands here when the shared vocabulary has no field for
something a reader genuinely needs, which so far has happened once.

## Stability

**An NSID is permanent.** These identifiers and field names appear in records that live
in other people's repositories, outside our control and beyond our ability to migrate;
renaming one does not fix old data, it forks it. So schemas here are additive-only:
new optional fields, never a renamed or repurposed existing one. A genuinely different
shape gets a new NSID and leaves the old one readable.

Note that an NSID's authority is its domain segments reversed, minus the final name
segment — `pub.goldroad.content.markdown` has the authority `content.goldroad.pub`, the
same way `app.bsky.feed.post` has the authority `feed.bsky.app`. If AT Protocol lexicon
resolution is later used to serve these schemas over the network, that is the name they
have to be served from.
