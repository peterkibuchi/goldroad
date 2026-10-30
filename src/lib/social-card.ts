/**
 * The default share card, and the tags that describe it.
 *
 * The root head defaults the IMAGE for every page (without one, a shared link
 * renders as a bare text card everywhere). It deliberately does not default the
 * dimensions or the alt text: a page that supplies its own og:image — a post
 * with a cover — overrides that one tag but cannot remove sibling ones, so
 * inherited width/height/alt would describe a picture that is no longer there.
 *
 * Whoever relies on the default therefore describes it, and the description
 * lives here rather than being retyped on each page: it is one sentence about
 * one image, and a sentence copied onto three pages is how the copies drift.
 */
import { CANONICAL_ORIGIN } from "~/lib/origin";

/** The default card image: `public/og.png`, 1200×630. */
export const DEFAULT_OG_IMAGE = `${CANONICAL_ORIGIN}/og.png`;

const DEFAULT_CARD_ALT =
  "Goldroad — writer-owned publishing. Your posts, your readers, your name, in an account you control.";

/**
 * Head meta for a page that has no picture of its own and so shows the default
 * card. Spread into `head().meta`.
 *
 * NOT for a page that sets its own og:image — these tags describe THIS image,
 * and that is the whole reason they are not defaulted at the root.
 */
export const DEFAULT_CARD_META = [
  { property: "og:image:width", content: "1200" },
  { property: "og:image:height", content: "630" },
  { property: "og:image:alt", content: DEFAULT_CARD_ALT },
  // X reads its alt text from here only, not from og:image:alt.
  { name: "twitter:image:alt", content: DEFAULT_CARD_ALT },
];

/**
 * The whole head for a first-party page that shows the default card: title,
 * description, the og:* set a link preview reads, and the canonical link, all
 * minted from the canonical origin. twitter:card comes from the root.
 */
export function defaultCardHead(input: {
  title: string;
  description: string;
  /** The page's path, e.g. "/privacy". */
  path: string;
}) {
  const url = `${CANONICAL_ORIGIN}${input.path}`;
  return {
    meta: [
      { title: input.title },
      { name: "description", content: input.description },
      { property: "og:title", content: input.title },
      { property: "og:description", content: input.description },
      { property: "og:type", content: "website" },
      { property: "og:url", content: url },
      ...DEFAULT_CARD_META,
    ],
    links: [{ rel: "canonical", href: url }],
  };
}
