import { describe, expect, it } from "vitest";

/**
 * The provenance stance, end to end in one file, because it is ONE decision
 * with three places that have to agree: the ledger records where a post came
 * from, the reader page's head decides whether to keep its canonical, and the
 * page body decides what sentence to print.
 *
 * The decision itself: a MIRROR (an import from someone else's publication,
 * still up) drops its canonical for noindex, because search engines should
 * index the original. A THREAD self-import does not, because the "original" is
 * a Bluesky post that was never an indexed web page competing for the query —
 * noindex there would suppress the only long-form copy of the writer's own
 * words in favour of nothing at all.
 *
 * Getting this backwards is silent and expensive: it de-indexes a writer's
 * archive, and nothing in the UI would show it. Hence a test per direction.
 */
import { documentHead, provenanceLine } from "../components/document-article";
import { keepsCanonical } from "../lib/mirror";

const BASE = {
  atUri:
    "at://did:plc:fake2222222222writer2222/site.standard.document/3abc2345678df",
  canonicalUrl: "https://goldroad.example/@writer.example/3abc2345678df",
  doc: { title: "On leaving", site: "https://goldroad.example/@w" },
  ident: "writer.example",
};

const THREAD_URL =
  "https://bsky.app/profile/did:plc:fake2222222222writer2222/post/3aa1";

describe("keepsCanonical", () => {
  it("keeps it for a native post and for a thread self-import", () => {
    expect(keepsCanonical(null)).toBe(true);
    expect(keepsCanonical(undefined)).toBe(true);
    expect(keepsCanonical({ kind: "thread", sourceUrl: THREAD_URL })).toBe(
      true,
    );
  });

  it("drops it for a mirror of someone else's publication", () => {
    expect(
      keepsCanonical({
        kind: "feed",
        sourceUrl: "https://writer.substack.com/p/x",
      }),
    ).toBe(false);
  });
});

describe("documentHead — indexing follows the source, not the import", () => {
  it("a thread self-import keeps its canonical and is NOT noindexed", () => {
    const head = documentHead({
      ...BASE,
      mirror: { kind: "thread", sourceUrl: THREAD_URL },
    });
    expect(head.meta).not.toContainEqual({
      content: "noindex",
      name: "robots",
    });
    expect(head.links).toContainEqual({
      href: BASE.canonicalUrl,
      rel: "canonical",
    });
  });

  it("a mirror still swaps its canonical for noindex", () => {
    const head = documentHead({
      ...BASE,
      mirror: { kind: "feed", sourceUrl: "https://writer.substack.com/p/x" },
    });
    expect(head.meta).toContainEqual({ content: "noindex", name: "robots" });
    expect(head.links?.some((link) => link.rel === "canonical")).toBe(false);
  });

  it("either way the at:// record link tags stay — interop is not SEO", () => {
    for (const kind of ["thread", "feed"] as const) {
      const { links } = documentHead({
        ...BASE,
        mirror: { kind, sourceUrl: THREAD_URL },
      });
      expect(links).toContainEqual({
        href: BASE.atUri,
        rel: "site.standard.document",
      });
    }
  });
});

describe("provenanceLine — what the page says out loud", () => {
  it("names the shape for a thread, not a host", () => {
    expect(provenanceLine({ kind: "thread", sourceUrl: THREAD_URL })).toEqual({
      href: THREAD_URL,
      label: "a thread on Bluesky",
      lead: "First published as",
    });
  });

  it("names the host for a mirror", () => {
    expect(
      provenanceLine({
        kind: "feed",
        sourceUrl: "https://writer.substack.com/p/x",
      }),
    ).toEqual({
      href: "https://writer.substack.com/p/x",
      label: "writer.substack.com",
      lead: "Originally published at",
    });
  });

  it("says nothing at all for a native post", () => {
    expect(provenanceLine(null)).toBeNull();
    expect(provenanceLine({ kind: "thread", sourceUrl: null })).toBeNull();
  });

  it("stays silent rather than promise an original it can't link", () => {
    // A stored URL that won't parse would otherwise render "Originally
    // published at" followed by nothing.
    expect(provenanceLine({ kind: "feed", sourceUrl: "not a url" })).toBeNull();
  });
});
