// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `/api/publish` intent=uploadImage — the inline-image blob upload.
 *
 * The PDS client is mocked at the @atcute/client seam so every branch is
 * reachable without a repo: what is pinned here is the gate order (CSRF →
 * session → MIME → size → upload), that a rejected upload NEVER answers a URL,
 * and that a successful one answers the same-origin /img proxy path plus the
 * blob the publish form has to hand back (the record must reference it or the
 * PDS will not serve it — see DocumentRecord in ~/lib/publish).
 */
const rpc = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("@atcute/client", () => ({
  Client: class {
    post = rpc.post;
  },
}));

const oauth = vi.hoisted(() => ({ restore: vi.fn() }));
vi.mock("~/lib/oauth", () => ({
  createOAuthClient: () => ({ restore: oauth.restore }),
}));

vi.mock("~/lib/atproto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/atproto")>();
  return {
    ...actual,
    resolveDidToHandle: vi.fn(async () => "writer.example"),
    resolveDidToPds: vi.fn(async () => "https://pds.example"),
  };
});

vi.mock("~/lib/live-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/live-session")>();
  const { readSessionDid } = await import("../lib/session");
  return {
    ...actual,
    readLiveSessionDid: (request: Request, secret: string) =>
      readSessionDid(request, secret),
  };
});

import { signSession } from "../lib/session";
import { Route } from "../routes/api.publish";
import { handlerOf } from "./support/route-handler";

const POST = handlerOf(Route, "POST");

const DID = "did:plc:fake2222222222writer2222";
const SECRET = "vitest-fake-cookie-secret"; // mirrors mocks/cloudflare-workers
const CID = "bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const blob = (over: Record<string, unknown> = {}) => ({
  $type: "blob",
  ref: { $link: CID },
  mimeType: "image/jpeg",
  size: 1234,
  ...over,
});

async function upload(
  file: File | null,
  opts: { authed?: boolean; origin?: string } = {},
): Promise<Response> {
  const form = new FormData();
  form.set("intent", "uploadImage");
  if (file) form.set("file", file);
  const headers: Record<string, string> = {};
  if (opts.authed !== false)
    headers.cookie = `gr_session=${await signSession(DID, SECRET)}`;
  if (opts.origin) headers.origin = opts.origin;
  return POST({
    request: new Request("http://127.0.0.1:3000/api/publish", {
      method: "POST",
      body: form,
      headers,
    }),
  });
}

const png = (bytes = 64, type = "image/png") =>
  new File([new Uint8Array(bytes)], "shot.png", { type });

beforeEach(() => {
  rpc.post.mockReset();
  oauth.restore.mockReset();
  oauth.restore.mockResolvedValue({});
});

describe("intent=uploadImage", () => {
  it("uploads the blob and answers the /img proxy path plus the blob", async () => {
    rpc.post.mockResolvedValue({ ok: true, data: { blob: blob() } });
    const res = await upload(png());

    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = (await res.json()) as {
      ok: boolean;
      url: string;
      blob: unknown;
    };
    expect(body.ok).toBe(true);
    // Proxy path, never a PDS-direct URL: /img is the moderation-aware,
    // cacheable, same-origin route, and this string lands in the record.
    expect(body.url).toBe(`/img/${encodeURIComponent(DID)}/${CID}`);
    expect(body.blob).toEqual(blob());
    expect(rpc.post).toHaveBeenCalledWith(
      "com.atproto.repo.uploadBlob",
      expect.objectContaining({ headers: { "content-type": "image/png" } }),
    );
  });

  it("refuses cross-site posts before reading the session", async () => {
    const res = await upload(png(), { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(rpc.post).not.toHaveBeenCalled();
  });

  it("401s without a session, and never uploads", async () => {
    const res = await upload(png(), { authed: false });
    expect([303, 401]).toContain(res.status);
    expect(rpc.post).not.toHaveBeenCalled();
  });

  it("answers JSON (not an HTML redirect) when the session can't be restored", async () => {
    oauth.restore.mockRejectedValue(new Error("gone"));
    const res = await upload(png());
    expect([303, 401]).toContain(res.status);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.json()).toEqual({ ok: false, error: "session_expired" });
  });

  it("400s a missing or empty file", async () => {
    expect((await upload(null)).status).toBe(400);
    expect((await upload(png(0))).status).toBe(400);
    expect(rpc.post).not.toHaveBeenCalled();
  });

  it("415s a type outside the raster allowlist — SVG included", async () => {
    for (const type of ["image/svg+xml", "application/pdf", "text/html"]) {
      const res = await upload(png(64, type));
      expect(res.status).toBe(415);
      expect(((await res.json()) as { error: string }).error).toBe(
        "image_type",
      );
    }
    expect(rpc.post).not.toHaveBeenCalled();
  });

  it("413s over the lexicon's 1MB blob cap — the client shrink is not trusted", async () => {
    const res = await upload(png(1_000_001));
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toBe(
      "image_too_large",
    );
    expect(rpc.post).not.toHaveBeenCalled();
  });

  it("reports a missing OAuth scope distinctly, so the writer can re-connect", async () => {
    rpc.post.mockResolvedValue({ ok: false, status: 403, data: {} });
    const res = await upload(png());
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("image_scope");
  });

  it("502s a failed upload — and a thrown one", async () => {
    rpc.post.mockResolvedValue({
      ok: false,
      status: 500,
      data: { error: "InternalServerError" },
    });
    expect((await upload(png())).status).toBe(502);

    rpc.post.mockRejectedValue(new Error("network"));
    const res = await upload(png());
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe(
      "upload_failed",
    );
  });

  it("502s a blob whose CID can't be served — never a broken URL", async () => {
    for (const bad of [
      undefined,
      { $type: "blob", ref: {}, mimeType: "image/png", size: 1 },
      blob({ ref: { $link: "../../etc/passwd" } }),
    ]) {
      rpc.post.mockResolvedValue({ ok: true, data: { blob: bad } });
      const res = await upload(png());
      expect(res.status).toBe(502);
      expect((await res.json()) as { url?: string }).not.toHaveProperty("url");
    }
  });
});
