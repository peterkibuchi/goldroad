// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

const DID = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";

vi.mock("~/lib/atproto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/atproto")>()),
  resolveReaderPds: vi.fn(async () => "https://pds.example"),
  resolveHandleToDid: vi.fn(async () => DID),
  listRecordsPage: vi.fn(async () => ({ records: [], cursor: null })),
  listRecords: vi.fn(async () => []),
  getRecordEntry: vi.fn(async () => ({
    uri: `at://${DID}/site.standard.document/3lyk73wxnok2f`,
    cid: "bafyreiexample",
    value: {
      $type: "site.standard.document",
      title: "A post",
      textContent: "Some bold words.",
      content: {
        $type: "at.markpub.markdown",
        text: { markdown: "Some **bold** words." },
      },
    },
  })),
}));
vi.mock("~/lib/moderation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/moderation")>()),
  checkHidden: vi.fn(async () => false),
}));
const former = vi.hoisted(() => ({
  target: null as { ident: string; permanent: boolean } | null,
}));
vi.mock("~/lib/handle-history", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/handle-history")>()),
  findFormerHandle: vi.fn(async () => former.target),
}));
vi.mock("~/lib/mirror", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/mirror")>()),
  checkMirror: vi.fn(async () => null),
}));

import { isNotFound, isRedirect } from "@tanstack/react-router";

import { documentHead, loadDocument } from "#/components/document-article";
import * as atproto from "~/lib/atproto";
import { findFormerHandle } from "~/lib/handle-history";

describe("loadDocument — the body", () => {
  it("ships the body rendered once, not its markdown and plaintext", async () => {
    const data = await loadDocument(DID, "3lyk73wxnok2f");
    expect(data.bodyHtml).toContain("<strong>bold</strong>");
    expect(data.readingMinutes).toBe(1);
    expect(data.doc.content).toBeUndefined();
    expect(data.doc.textContent).toBeUndefined();
    expect(data.doc.title).toBe("A post");
  });
});

describe("loadDocument — the share card", () => {
  const CARD = "bafkreicardcardcardcardcardcardcardcard";
  const COVER = "bafkreicovercovercovercovercovercoverco";
  const blob = (cid: string, mimeType = "image/png") => ({
    $type: "blob",
    ref: { $link: cid },
    mimeType,
    size: 61_234,
  });
  const withFields = (fields: Record<string, unknown>) =>
    vi.mocked(atproto.getRecordEntry).mockResolvedValueOnce({
      uri: `at://${DID}/site.standard.document/3lyk73wxnok2f`,
      cid: "bafyreiexample",
      value: { $type: "site.standard.document", title: "A post", ...fields },
    });
  type Tag = { property?: string; content?: string };
  const ogImage = (data: Awaited<ReturnType<typeof loadDocument>>) =>
    (documentHead(data).meta as Tag[])
      .filter((m) => m.property === "og:image")
      .map((m) => m.content);

  it("leads the link preview with the card the record names", async () => {
    withFields({ goldroadShareCard: blob(CARD), coverImage: blob(COVER) });
    const data = await loadDocument(DID, "3lyk73wxnok2f");
    expect(data.shareCard).toEqual({ did: DID, cid: CARD });
    expect(ogImage(data)).toEqual([
      `https://trygoldroad.com/img/${encodeURIComponent(DID)}/${CARD}`,
    ]);
    // Shipped once, as the ref: not again inside the document.
    expect(data.doc.goldroadShareCard).toBeUndefined();
  });

  it("keeps the cover for a record without one, as other apps' posts are", async () => {
    withFields({ coverImage: blob(COVER, "image/jpeg") });
    const data = await loadDocument(DID, "3lyk73wxnok2f");
    expect(data.shareCard).toBeNull();
    expect(ogImage(data)).toEqual([
      `https://trygoldroad.com/img/${encodeURIComponent(DID)}/${COVER}`,
    ]);
  });

  it("ignores a field that isn't a raster blob", async () => {
    withFields({ goldroadShareCard: blob(CARD, "image/svg+xml") });
    const data = await loadDocument(DID, "3lyk73wxnok2f");
    expect(data.shareCard).toBeNull();
  });
});

describe("loadDocument — a link minted under an old handle", () => {
  const stale = async () => {
    vi.mocked(atproto.resolveHandleToDid).mockRejectedValueOnce(
      new atproto.NotFoundError("handle did not resolve"),
    );
    return loadDocument("alice.example", "3lyk73wxnok2f").catch((e) => e);
  };

  it("301s to the writer's current handle", async () => {
    former.target = { ident: "alice.com", permanent: true };
    const thrown = await stale();
    expect(isRedirect(thrown)).toBe(true);
    expect(thrown.options.href).toBe("/@alice.com/3lyk73wxnok2f");
    expect(thrown.options.statusCode).toBe(301);
  });

  it("still 404s a handle nobody we know used", async () => {
    former.target = null;
    expect(isNotFound(await stale())).toBe(true);
  });

  it("never asks about a handle that still resolves", async () => {
    // A missing post or a PDS outage is not a handle change.
    vi.mocked(findFormerHandle).mockClear();
    vi.mocked(atproto.getRecordEntry).mockRejectedValueOnce(
      new atproto.NotFoundError("no such record"),
    );
    const thrown = await loadDocument("alice.example", "3lyk73wxnok2f").catch(
      (e) => e,
    );
    expect(isNotFound(thrown)).toBe(true);
    expect(findFormerHandle).not.toHaveBeenCalled();
  });
});
