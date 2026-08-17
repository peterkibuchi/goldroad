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

const gates = vi.hoisted(() => ({
  /** Opened when resolveDidToPds is entered. */
  pdsEntered: undefined as ReturnType<typeof makeGate> | undefined,
  /** Opened when listRecordsPage (the "More from…" read) is entered. */
  relatedEntered: undefined as ReturnType<typeof makeGate> | undefined,
  /** What the takedown check should answer once its gate settles. */
  hiddenWhenOpened: false,
  /** Make the DID-document resolution fail. */
  pdsRejects: false,
}));

vi.mock("~/lib/atproto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/atproto")>();
  return {
    ...actual,
    resolveHandleToDid: vi.fn(async () => DID),
    resolveDidToPds: vi.fn(async () => {
      gates.pdsEntered?.open();
      if (gates.pdsRejects)
        throw new actual.NotFoundError("directory unreachable");
      return PDS;
    }),
    // The document read waits for the related-posts read to be entered, so a
    // loader that still queues them reports "sequential" in the title.
    getRecordEntry: vi.fn(async () => {
      const observed = (await gates.relatedEntered?.wait()) ?? "opened";
      return {
        uri: `at://${DID}/site.standard.document/${RKEY}`,
        cid: "bafyfake",
        value: { title: observed === "opened" ? "concurrent" : "sequential" },
      };
    }),
    listRecordsPage: vi.fn(async () => {
      gates.relatedEntered?.open();
      return { records: [], cursor: null };
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
  getDocumentEngagement: vi.fn(async () => null),
}));
vi.mock("~/lib/comments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/comments")>()),
  getPostConversation: vi.fn(async () => null),
}));

import { loadDocument } from "../components/document-article";

function reset() {
  gates.pdsEntered = makeGate();
  gates.relatedEntered = makeGate();
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
