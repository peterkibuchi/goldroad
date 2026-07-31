# Design

The visual and verbal system. Read this before touching UI — most of what looks like a
style preference here is a rule with a reason behind it.

## The two-surface rule (load-bearing)

Goldroad has exactly two registers, and they never mix on one screen.

- **Pressroom** — marketing pages and app chrome. Ink on paper, one scarce vermillion spot
  color, Franklin-lineage display type, hairline and double rules, square corners. This is
  Goldroad speaking.
- **Calm** — everything a writer writes in or a reader reads. Serif body text, generous
  measure, near-zero ornament. The platform disappears and the writer's identity
  dominates. Third-party authors' pages get exactly the same respect as ours.

When in doubt: if the user is consuming or creating words, calm; if we are talking about
ourselves, Pressroom.

### The printer's mark

The one place the two surfaces genuinely pull against each other is the footer. The rule
says the platform disappears on a reading page; the project's central claim — that it
can't be taken away — is worthless if a reader can't check it. A printed book settled
this centuries ago, and so do we:

- **Marketing surfaces** (`/`, `/leaving-substack`, `/open`) get the full two-deck
  footer: Product / Open / Legal columns over the closing band.
- **App chrome** gets the single band with the open-source items inline, so the licence
  and the source are one click from every screen a writer works in.
- **Reading surfaces** get neither. The writer's items lead, and Goldroad appears once,
  last, at whisper weight — one clause pointing at `/open`. Never a band, never a badge,
  never above the writer's own words.

Note that the Pressroom *visual* system stayed while the press *metaphor* was retired from
the words. An earlier version of the site leaned on printing-trade language ("the presses
are warming", "set in type") and read as machine-written. The typography survived that
correction; the cosplay didn't.

## Tokens

Source of truth is the `@theme` block in `src/styles.css`. Don't hard-code these values in
components — use the token.

- `--color-paper` `oklch(1 0 0)` · `--color-ink` `oklch(0.2 0 0)` · `--color-ink-soft`
  `oklch(0.42 0 0)` · `--color-rule` `oklch(0.85 0 0)` · `--color-spot`
  `oklch(0.54 0.19 33)`
- `--font-display` Libre Franklin (mastheads, headings, interface labels) · `--font-body`
  Source Serif 4 (prose). Both self-hosted.

**Spot color is scarce by design: one accent moment per view** — a highlight, or the
primary action, or a kicker. If two spot elements compete on one screen, one of them is
wrong. This is the constraint most likely to be violated by well-intentioned changes.

On the signed-in writer surfaces that moment is **spent by the chrome, once**: the command
rail's "New post" button. Chrome spends no spot anywhere else — every navigation row, and
the active-section marker, is ink. The amendment is deliberate: the writer's single most
important act wears the product's single accent, in the same place, on every surface they
work in. Its consequence is paid on the pages, which is the part that gets forgotten —
page-level primaries on those surfaces take the ink vocabulary instead, and the posts
manager has no "New post" of its own because the rail carries it. The reasoning, and the
ink fallback if the rail button proves too loud in practice, are written down at
`RailPrimaryAction` in `src/components/site-chrome.tsx`.

Borders are 1–2px solid ink, or 3px double for Pressroom structure; hairline `--color-rule`
for calm separations. No shadows as decoration. Radius is 0 on Pressroom surfaces — print
doesn't round corners — while editor and shadcn internals keep their own small radius.

## Type and motifs

- Display type is Libre Franklin 800–900, tight leading, `text-balance`, topping out
  around `text-7xl`.
- `.spot-highlight` marks **the** claim of a page — one per page, maximum. It's a
  background-positioned bar hugging the baseline, so it clones correctly across wrapped
  lines at any size.
- Registration marks and "Proof No." slugs are marketing garnish only. They never appear
  on a reading or writing surface.
- Prose: measure at or under 70ch, leading 1.6+, headings shifted one level below the
  document title.

## Voice

Plain, outcome-first copy. At most one subtle flourish per marketing page, and **zero in
system strings** — buttons, form states, errors, empty states, 404 and 500 pages.

Headlines say what the writer gets. The test to apply: would a Bluesky-native writer
screenshot this line, or cringe at it?

- Label actions by their outcome for the writer, not the mechanism.
- No protocol jargon on user surfaces. No "PDS", "record", or "lexicon" — "your data
  repo", at most, in first-run education.
- Errors say what to do next and never blame the user. Empty states teach the next step.
- **State promises positively.** "We'll never sell your list" names the fear and thereby
  evokes it; "your followers stay yours" is the same promise as a possession. If a
  sentence needs a "never" to be comforting, rewrite it as a freedom.
- Unshipped features are marked as on the roadmap, never described in the present tense.

## Interaction vocabulary

- **Primary action** (one per view): `bg-spot text-paper hover:bg-ink`.
- **Secondary and inline actions**: ink-soft underlined text links hovering to ink.
  Destructive actions hover to spot and confirm before acting.
- **Empty-state CTA**: `bg-ink hover:bg-spot`, so it doesn't compete with the page's own
  accent moment.
- **Touch targets** on interactive chrome are at least 44px (`min-h-11`, or `min-h-9` plus
  negative margin inside dense rows).
- **Loading shows skeletons, never spinners.** The router's pending component and the
  editor's lazy-load both use matching pulse bars, and both carry
  `motion-reduce:animate-none`.

## Accessibility baseline

Focus-visible outlines in spot color everywhere, from a single global rule — 2px at 2px
offset. Forms fully keyboard-operable. Honeypot fields stay out of the accessibility tree.
Body text holds at least 4.5:1 contrast; ink-soft on paper passes and must never be
lightened past it. Motion stays under ~150ms and is limited to color and transform; any
future entrance animation needs a reduced-motion fallback.

## Dark mode is deferred, deliberately

Product surfaces are light-only for now. This is a decision, not an oversight: the
Pressroom register is literally ink on paper, so a dark theme is a second art direction
rather than a variable swap. Reading surfaces will get a dark treatment when writer
theming lands, which is the protocol-native place for it — a theme belongs to the writer's
publication, not to our toggle. The `.dark` variable block in `styles.css` exists only to
keep editor internals sane; no product surface sets the class.

Revisit when writer theming ships, or when readers ask for it.
