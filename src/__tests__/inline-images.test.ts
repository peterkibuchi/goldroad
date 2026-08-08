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
  downscaleNotice,
  formatBytes,
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

  /**
   * The store lives for one mount. A writer who resumes a draft, changes a
   * word and publishes uploads nothing — so without adoption the `images`
   * field goes up empty, the record references none of its own pictures, and
   * the PDS reclaims blobs nothing points at. The post is then live with
   * images that cannot be restored.
   */
  it("adopts the blobs a previous session uploaded for this draft", () => {
    const store = createInlineImageStore();
    store.adopt([BLOB]);
    expect(JSON.parse(store.toField())).toEqual([BLOB]);
    expect(store.size).toBe(1);
  });

  it("does not duplicate an adopted blob that is re-uploaded", () => {
    const store = createInlineImageStore();
    store.adopt([BLOB]);
    store.adopt([BLOB]);
    expect(JSON.parse(store.toField())).toEqual([BLOB]);
  });

  it("ignores stored entries that carry no blob reference", () => {
    const store = createInlineImageStore();
    store.adopt([null, "junk", {}, { ref: {} }, { ref: { $link: 7 } }]);
    expect(store.toField()).toBe("");
  });

  it("keeps this session's uploads alongside the adopted ones", () => {
    const store = createInlineImageStore();
    store.adopt([BLOB]);
    const fresh = { ...BLOB, ref: { $link: "bafyfresh" } };
    store.remember({ url: "/img/did/bafyfresh", blob: fresh });
    expect(JSON.parse(store.toField())).toHaveLength(2);
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
      // Default to a no-op downscale so the upload tests aren't testing it.
      prepare: async (file: File) => file,
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

  it("shrinks an over-cap image, uploads the SHRUNK bytes, and says what it did", async () => {
    const big = new File([new Uint8Array(64)], "shot.png", {
      type: "image/png",
    });
    // A 4 MB screenshot: the ordinary case, not the edge case.
    Object.defineProperty(big, "size", { value: 4_200_000 });
    const small = new File([new Uint8Array(8)], "shot.jpg", {
      type: "image/jpeg",
    });
    Object.defineProperty(small, "size", { value: 780_000 });

    const upload = vi.fn(async () => ({ url: URL_PATH, blob: BLOB }));
    const { handler, statuses } = uploader({
      upload,
      prepare: async () => small,
    });

    expect(await handler(big)).toEqual({ props: { url: URL_PATH } });
    // The original must never be what goes over the wire — the server caps
    // at 1 MB and would refuse it.
    expect(upload).toHaveBeenCalledWith(small);
    expect(statuses.at(-1)?.tone).toBe("info");
    expect(statuses.at(-1)?.message).toMatch(
      /Shrank that image from 4\.2 MB to 780 KB so it fits the 1 MB limit\./,
    );
    expect(statuses.at(-1)?.message).toMatch(/alt text/);
  });

  it("stays quiet about a shrink when nothing was actually shrunk", async () => {
    const { handler, statuses } = uploader();
    await handler(png());
    expect(statuses.at(-1)?.message).not.toMatch(/Shrank/);
  });

  it("reports an image it cannot decode or compress, and uploads nothing", async () => {
    const upload = vi.fn();
    const { handler, store, statuses } = uploader({
      upload,
      prepare: async () => {
        throw new Error("could not compress image under the size limit");
      },
    });

    // Never a silent drop and never a rejection: BlockNote awaits this
    // uncaught, so the writer has to be told in the editor.
    await expect(handler(png())).resolves.toEqual({});
    expect(upload).not.toHaveBeenCalled();
    expect(store.toField()).toBe("");
    expect(statuses.at(-1)).toEqual({
      tone: "error",
      message: expect.stringContaining("couldn't be read or shrunk under 1 MB"),
    });
  });

  it("accepts a type the server refuses but the downscale can convert", async () => {
    const heic = new File([new Uint8Array(8)], "IMG_1.heic", {
      type: "image/heic",
    });
    const jpeg = new File([new Uint8Array(8)], "IMG_1.jpg", {
      type: "image/jpeg",
    });
    const upload = vi.fn(async () => ({ url: URL_PATH, blob: BLOB }));
    const { handler } = uploader({ upload, prepare: async () => jpeg });

    expect(await handler(heic)).toEqual({ props: { url: URL_PATH } });
    expect(upload).toHaveBeenCalledWith(jpeg);
  });

  it("says so rather than uploading when there is no store", async () => {
    const upload = vi.fn();
    const { handler, statuses } = uploader({ store: () => undefined, upload });
    expect(await handler(png())).toEqual({});
    expect(upload).not.toHaveBeenCalled();
    expect(statuses.at(-1)?.tone).toBe("error");
  });
});

describe("downscaleNotice", () => {
  it("states the before and after, in units a writer reads", () => {
    expect(downscaleNotice(4_200_000, 780_000)).toBe(
      "Shrank that image from 4.2 MB to 780 KB so it fits the 1 MB limit.",
    );
    expect(formatBytes(1_500_000)).toBe("1.5 MB");
    expect(formatBytes(900)).toBe("1 KB"); // never "0 KB"
  });

  it("is silent when the file came back the same size or larger", () => {
    expect(downscaleNotice(900_000, 900_000)).toBeNull();
    expect(downscaleNotice(900_000, 950_000)).toBeNull();
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
