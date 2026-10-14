// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

const DID = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";

vi.mock("~/lib/atproto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/atproto")>()),
  resolveReaderPds: vi.fn(async () => "https://pds.example"),
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
vi.mock("~/lib/mirror", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/mirror")>()),
  checkMirror: vi.fn(async () => null),
}));

import { loadDocument } from "#/components/document-article";

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
