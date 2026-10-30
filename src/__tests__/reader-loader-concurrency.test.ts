// @vitest-environment node
import { isNotFound } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vitest";

/**
 * A cold reading surface was taking 3.3–8.9 s to first byte because its loader
 * ran its upstream reads in a queue: handle→DID, then a D1 takedown check, then
 * the DID document, then the record, then everything else. Only the last step
 * was concurrent. Link-preview scrapers — Bluesky's card service included —
 * gave up before it finished, so shared posts rendered as bare text cards.
 *
 * These tests pin the CONCURRENCY, which is the fix, rather than a wall-clock
 * number, which would be a flake. The technique: one mocked call refuses to
 * resolve until another has been ENTERED. If the loader still awaits them in
 * sequence, the gate never opens, and the mock reports "sequential" instead of
 * hanging — so a regression fails with a readable assertion rather than a
 * timeout.
 *
 * The third test is the seam the concurrency put at risk. Running the takedown
 * check alongside the DID-document fetch means the two can now fail in either
 * order, and a `Promise.all` would have surfaced whichever lost — turning a
 * takedown notice into a generic 404 for any hidden author whose directory was
 * unreachable. That ordering is load-bearing and is asserted here.
 */

type GateResult = "opened" | "sequential";

/** A one-shot gate a mock can wait on, which reports rather than hangs. */
function makeGate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    open,
    /** "opened" if the other call was entered concurrently; "sequential" if the
     * loader is still waiting on THIS call before making that one. */
    async wait(ms = 2_000): Promise<GateResult> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const gaveUp = new Promise<GateResult>((resolve) => {
        timer = setTimeout(() => resolve("sequential"), ms);
      });
      const result = await Promise.race([
        opened.then((): GateResult => "opened"),
        gaveUp,
      ]);
      if (timer) clearTimeout(timer);
      return result;
    },
  };
}

const DID = "did:plc:ukp7pzzht32uigg6bg4vxr5t";
const RKEY = "3lyk73wxnok2f";
const PDS = "https://pds.example";
const PUB_RKEY = "3lyk73wxpub22";
const REPLIES = { replies: [], threadUrl: "https://bsky.app/x", hasMore: true };
const ENGAGEMENT = {
  counts: { likeCount: 3 },
  threadUrl: "https://bsky.app/x",
};

const gates = vi.hoisted(() => ({
  /** Opened when resolveReaderPds is entered. */
  pdsEntered: undefined as ReturnType<typeof makeGate> | undefined,
  /** Opened when listRecordsPage (the "More from…" read) is entered. */
  relatedEntered: undefined as ReturnType<typeof makeGate> | undefined,
  /** Opened when listRecords (the publication listing) is entered. */
  pubsEntered: undefined as ReturnType<typeof makeGate> | undefined,
  /** Released by the test; the reply fetch waits on it. */
  repliesReleased: undefined as ReturnType<typeof makeGate> | undefined,
  /** Released by the test; the like-count fetch waits on it. */
  engagementReleased: undefined as ReturnType<typeof makeGate> | undefined,
  /** What the takedown check should answer once its gate settles. */
  hiddenWhenOpened: false,
  /** Make the DID-document resolution fail. */
  pdsRejects: false,
  /** Whether the publication listing holds the document's publication. */
  listing: "has" as "has" | "lacks" | "rejects",
  /** A PDS that refuses the document (a writer who moved away from it), and
   * the one a fresh resolution names instead. */
  refusingPds: null as string | null,
  movedTo: null as string | null,
  /** What resolveReaderPds answers. */
  currentPds: "https://pds.example",
}));

vi.mock("~/lib/atproto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/atproto")>();
  return {
    ...actual,
    resolveHandleToDid: vi.fn(async () => DID),
    resolveReaderPds: vi.fn(async () => {
      gates.pdsEntered?.open();
      if (gates.pdsRejects)
        throw new actual.NotFoundError("directory unreachable");
      return gates.currentPds;
    }),
    // The document read waits for the related-posts read AND the publication
    // listing to be entered, so a loader that still queues either reports
    // "sequential" in the title. A direct publication read (the fallback when
    // the listing misses) answers with a name the listing never carries.
    getRecordEntry: vi.fn(async (pds: string, _did: string, collection) => {
      if (collection === "site.standard.publication")
        return { uri: "", value: { name: "read directly" } };
      if (pds === gates.refusingPds)
        throw new actual.NotFoundError("repo not on this PDS");
      const related = (await gates.relatedEntered?.wait()) ?? "opened";
      const pubs = (await gates.pubsEntered?.wait()) ?? "opened";
      const concurrent = related === "opened" && pubs === "opened";
      return {
        uri: `at://${DID}/site.standard.document/${RKEY}`,
        cid: "bafyfake",
        value: {
          title: concurrent ? "concurrent" : "sequential",
          site: `at://${DID}/site.standard.publication/${PUB_RKEY}`,
        },
      };
    }),
    listRecordsPage: vi.fn(async () => {
      gates.relatedEntered?.open();
      return { records: [], cursor: null };
    }),
    // Stands in for the real one, which stores the fresh answer in the cache.
    refreshReaderPds: vi.fn(async () => {
      if (gates.movedTo) gates.currentPds = gates.movedTo;
      return gates.movedTo;
    }),
    listRecords: vi.fn(async () => {
      gates.pubsEntered?.open();
      if (gates.listing === "rejects")
        throw new actual.ListUnavailableError("PDS overloaded");
      if (gates.listing === "lacks") return [];
      return [
        {
          uri: `at://${DID}/site.standard.publication/3otherpub2222`,
          cid: "bafyother",
          value: { name: "Another publication" },
        },
        {
          uri: `at://${DID}/site.standard.publication/${PUB_RKEY}`,
          cid: "bafypub",
          value: { name: "From the listing" },
        },
      ];
    }),
  };
});

vi.mock("~/lib/moderation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/moderation")>();
  return {
    ...actual,
    // The takedown check waits for the DID-document fetch to be entered. A
    // loader that resolves the PDS only afterwards never opens the gate.
    checkHidden: vi.fn(async () => {
      const observed = (await gates.pdsEntered?.wait()) ?? "opened";
      return observed === "opened" ? gates.hiddenWhenOpened : false;
    }),
  };
});

vi.mock("~/lib/mirror", () => ({ checkMirror: vi.fn(async () => null) }));
vi.mock("~/lib/engagement", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/engagement")>()),
  // Held until the test releases it, like the replies below.
  getDocumentEngagement: vi.fn(async () => {
    await gates.engagementReleased?.wait();
    return ENGAGEMENT;
  }),
}));
vi.mock("~/lib/comments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/comments")>()),
  // Held until the test releases it: a loader that awaits the replies can't
  // return before then, and reports that instead of hanging.
  getPostConversation: vi.fn(async () => {
    await gates.repliesReleased?.wait();
    return REPLIES;
  }),
}));

import {
  getRecordEntry,
  listRecords,
  listRecordsPage,
  refreshReaderPds,
} from "~/lib/atproto";
import { loadDocument } from "../components/document-article";

function reset() {
  gates.pdsEntered = makeGate();
  gates.relatedEntered = makeGate();
  gates.pubsEntered = makeGate();
  // Released at once unless a test holds it.
  gates.repliesReleased = makeGate();
  gates.repliesReleased.open();
  gates.engagementReleased = makeGate();
  gates.engagementReleased.open();
  gates.listing = "has";
  gates.refusingPds = null;
  gates.movedTo = null;
  gates.currentPds = PDS;
  vi.mocked(refreshReaderPds).mockClear();
  vi.mocked(getRecordEntry).mockClear();
  vi.mocked(listRecords).mockClear();
  vi.mocked(listRecordsPage).mockClear();
  gates.hiddenWhenOpened = false;
  gates.pdsRejects = false;
}

describe("reading-surface loader concurrency", () => {
  it("resolves the PDS while the takedown check is still in flight", async () => {
    reset();
    // The check answers "hidden" only if it saw the DID-document fetch start
    // alongside it. A sequential loader answers "not hidden" and the page loads.
    gates.hiddenWhenOpened = true;

    let thrown: unknown;
    try {
      await loadDocument("writer.example", RKEY);
    } catch (err) {
      thrown = err;
    }

    expect(
      isNotFound(thrown),
      "the D1 takedown check still waits for its own round trip before the DID document is fetched",
    ).toBe(true);
    expect((thrown as { data?: { hidden?: boolean } }).data?.hidden).toBe(true);
    // Nothing of a hidden subject's is fetched, the new listing included.
    expect(getRecordEntry).not.toHaveBeenCalled();
    expect(listRecords).not.toHaveBeenCalled();
    expect(listRecordsPage).not.toHaveBeenCalled();
  });

  it("reads the record and the related-posts page against the PDS together", async () => {
    reset();
    const data = await loadDocument("writer.example", RKEY);
    // Both reads need only pds + did, so the second has no reason to queue
    // behind the first — that was one whole PDS round trip on the critical path.
    expect(
      data.doc.title,
      "the related-posts read still waits for the document read to finish",
    ).toBe("concurrent");
  });

  it("lists the publications while the document is being read", async () => {
    reset();
    const data = await loadDocument("writer.example", RKEY);
    // Which publication the document belongs to is only known once it
    // arrives; reading that record afterwards was one more PDS round trip in
    // front of the first byte. The listing that ran alongside already has it.
    expect(
      data.doc.title,
      "the publication read still waits for the document read to finish",
    ).toBe("concurrent");
    expect(data.publicationName).toBe("From the listing");
    expect(getRecordEntry).toHaveBeenCalledTimes(1);
  });

  it("reads the publication directly when the listing doesn't have it", async () => {
    for (const listing of ["lacks", "rejects"] as const) {
      reset();
      gates.listing = listing;
      const data = await loadDocument("writer.example", RKEY);
      expect(data.publicationName, listing).toBe("read directly");
      expect(getRecordEntry).toHaveBeenCalledTimes(2);
    }
  });

  it("reads again from the new PDS when the cached one refuses", async () => {
    reset();
    // A writer who moved: the cached PDS refuses, a fresh resolution names the
    // new one, and the post loads from there.
    gates.refusingPds = PDS;
    gates.movedTo = "https://new-pds.example";
    const data = await loadDocument("writer.example", RKEY);
    expect(data.doc.title).toBe("concurrent");
    expect(refreshReaderPds).toHaveBeenCalledWith(DID, PDS);
  });

  it("serves the 404 when the refusal stands", async () => {
    reset();
    gates.refusingPds = PDS;
    let thrown: unknown;
    try {
      await loadDocument("writer.example", RKEY);
    } catch (err) {
      thrown = err;
    }
    expect(isNotFound(thrown)).toBe(true);
    expect(refreshReaderPds).toHaveBeenCalledTimes(1);
  });

  // The counts and the replies both render below the article, so the page
  // streams them in after it rather than holding the first byte for an
  // AppView round trip.
  it.each([
    {
      what: "replies",
      gate: "repliesReleased",
      field: "conversation",
      value: REPLIES,
    },
    {
      what: "like counts",
      gate: "engagementReleased",
      field: "engagement",
      value: ENGAGEMENT,
    },
  ] as const)(
    "returns the article without waiting for the $what",
    async ({ what, gate, field, value }) => {
      reset();
      const held = makeGate();
      gates[gate] = held;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        loadDocument("writer.example", RKEY).then((data) => ({ data })),
        new Promise<"waited">((resolve) => {
          timer = setTimeout(resolve, 1_000, "waited");
        }),
      ]);
      clearTimeout(timer);
      // Released either way, so a loader still waiting on it can finish.
      held.open();
      expect(outcome, `the loader still waits for the ${what}`).not.toBe(
        "waited",
      );
      if (outcome === "waited") return;
      await expect(outcome.data[field]).resolves.toEqual(value);
    },
  );

  it("still shows the takedown notice when the DID document is unreachable", async () => {
    reset();
    gates.hiddenWhenOpened = true;
    gates.pdsRejects = true;

    let thrown: unknown;
    try {
      await loadDocument("writer.example", RKEY);
    } catch (err) {
      thrown = err;
    }

    // The takedown answer outranks every other failure. Awaiting the two
    // together with Promise.all would surface the directory error instead and
    // serve the generic not-found copy for a subject we were told to hide.
    expect(isNotFound(thrown)).toBe(true);
    expect((thrown as { data?: { hidden?: boolean } }).data?.hidden).toBe(true);
  });
});
