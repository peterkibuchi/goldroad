// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

/**
 * The browser half of inline images: the upload call, the session store that
 * bridges "uploaded" and "published", the editor's uploadFile handler, and the
 * block inspections the write page reports from.
 */
import {
  createInlineImageStore,
  createInlineImageUploader,
  hasProxiedImages,
  imagesMissingAltText,
  type UploadStatus,
  uploadInlineImage,
} from "../lib/inline-images";

const CID = "bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const URL_PATH = `/img/did%3Aplc%3Awriter/${CID}`;
const BLOB = {
  $type: "blob",
  ref: { $link: CID },
  mimeType: "image/png",
  size: 900,
};

const png = () =>
  new File([new Uint8Array(8)], "cat.png", { type: "image/png" });

const jsonResponse = (body: unknown, status = 201) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("uploadInlineImage", () => {
  it("posts the upload intent to the single publish handler", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, url: URL_PATH, blob: BLOB }),
    );
    const result = await uploadInlineImage(png(), fetchImpl as typeof fetch);

    expect(result).toEqual({ url: URL_PATH, blob: BLOB });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/publish");
    expect(init.method).toBe("POST");
    const form = init.body as FormData;
    expect(form.get("intent")).toBe("uploadImage");
    expect(form.get("file")).toBeInstanceOf(File);
  });

  it("throws the writer-facing message for a known error code", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: false, error: "image_scope" }, 403),
    );
    await expect(
      uploadInlineImage(png(), fetchImpl as typeof fetch),
    ).rejects.toThrow(/permission your sign-in doesn't include/);
  });

  it("treats a non-JSON answer, a network failure, and a 200 without a URL as failures", async () => {
    const html = vi.fn(async () => new Response("<html>oops</html>"));
    await expect(
      uploadInlineImage(png(), html as unknown as typeof fetch),
    ).rejects.toThrow();

    const boom = vi.fn(async () => {
      throw new Error("offline");
    });
    await expect(
      uploadInlineImage(png(), boom as unknown as typeof fetch),
    ).rejects.toThrow(/connection/);

    const empty = vi.fn(async () => jsonResponse({ ok: true }, 200));
    await expect(
      uploadInlineImage(png(), empty as typeof fetch),
    ).rejects.toThrow();
  });
});

describe("the session store", () => {
  it("submits every uploaded blob, and displays local bytes until publish", () => {
    const store = createInlineImageStore();
    expect(store.toField()).toBe("");

    store.remember({ url: URL_PATH, blob: BLOB }, "blob:local-1");
    expect(JSON.parse(store.toField())).toEqual([BLOB]);
    // The blob is in the repo but no record references it yet, so the proxy
    // path cannot resolve — the editor shows the local copy instead.
    expect(store.display(URL_PATH)).toBe("blob:local-1");
    // Anything we didn't upload resolves as written (a published post's image).
    expect(store.display("/img/did%3Aplc%3Aother/x")).toBe(
      "/img/did%3Aplc%3Aother/x",
    );
  });
});

describe("the editor's uploadFile handler", () => {
  const uploader = (
    over: Partial<Parameters<typeof createInlineImageUploader>[0]> = {},
  ) => {
    const store = createInlineImageStore();
    const statuses: UploadStatus[] = [];
    const handler = createInlineImageUploader({
      store: () => store,
      onStatus: (status) => statuses.push(status),
      upload: async () => ({ url: URL_PATH, blob: BLOB }),
      previewUrl: () => "blob:local-1",
      ...over,
    });
    return { handler, store, statuses };
  };

  it("returns the proxy path as the block's URL and remembers the blob", async () => {
    const { handler, store, statuses } = uploader();
    expect(await handler(png())).toEqual({ props: { url: URL_PATH } });
    expect(JSON.parse(store.toField())).toEqual([BLOB]);
    expect(statuses.at(-1)?.tone).toBe("info");
    expect(statuses.at(-1)?.message).toMatch(/alt text/);
  });

  it("refuses a non-image without a round trip, and says why", async () => {
    const upload = vi.fn();
    const { handler, statuses } = uploader({ upload });
    const pdf = new File([new Uint8Array(4)], "a.pdf", {
      type: "application/pdf",
    });
    expect(await handler(pdf)).toEqual({});
    expect(upload).not.toHaveBeenCalled();
    expect(statuses.at(-1)).toEqual({
      tone: "error",
      message: expect.stringContaining("JPEG, PNG, WebP, AVIF, or GIF"),
    });
  });

  it("never rejects on failure — it reports it and leaves the block empty", async () => {
    const { handler, store, statuses } = uploader({
      upload: async () => {
        throw new Error("Your server wouldn't store that image. Try again.");
      },
    });
    // A rejection here would be an unhandled promise on BlockNote's drop path.
    await expect(handler(png())).resolves.toEqual({});
    expect(statuses.at(-1)).toEqual({
      tone: "error",
      message: "Your server wouldn't store that image. Try again.",
    });
    expect(store.toField()).toBe(""); // nothing half-recorded
  });

  it("says so rather than uploading when there is no store", async () => {
    const upload = vi.fn();
    const { handler, statuses } = uploader({ store: () => undefined, upload });
    expect(await handler(png())).toEqual({});
    expect(upload).not.toHaveBeenCalled();
    expect(statuses.at(-1)?.tone).toBe("error");
  });
});

describe("block inspections", () => {
  const image = (props: Record<string, unknown>) => ({ type: "image", props });

  it("counts images with no alt text, nested ones included", () => {
    expect(
      imagesMissingAltText([
        image({ url: URL_PATH, name: "A cat on a wall" }),
        image({ url: URL_PATH, name: "" }),
        image({ url: URL_PATH, name: "   " }),
        image({ url: "", name: "" }), // empty placeholder — not yet an image
        { type: "paragraph", children: [image({ url: URL_PATH })] },
      ]),
    ).toBe(3);
  });

  it("spots draft images that can't render until the draft publishes", () => {
    expect(hasProxiedImages([image({ url: URL_PATH })])).toBe(true);
    expect(
      hasProxiedImages([image({ url: "https://example.com/cat.png" })]),
    ).toBe(false);
    expect(hasProxiedImages([{ type: "paragraph" }, null, "junk"])).toBe(false);
  });
});
