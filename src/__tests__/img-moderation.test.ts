// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { env } from "cloudflare:workers";

// The takedown check is the unit under test; anyHidden is mocked to isolate the
// route's 451 branch from a live D1.
vi.mock("~/lib/moderation", () => ({ anyHidden: vi.fn(async () => true) }));

import { Route } from "../routes/img.$did.$cid";

const DID = "did:plc:fake2222222222writer2222";
const CID = "bafkreicanarycanarycanarycanarycanarycanary";

type Handler = (ctx: {
  request: Request;
  params: { did: string; cid: string };
}) => Promise<Response>;
const GET = (
  Route.options as unknown as { server: { handlers: { GET: Handler } } }
).server.handlers.GET;

afterEach(() => {
  // biome-ignore lint/suspicious/noExplicitAny: mutating the test env stub
  delete (env as any).DB;
});

describe("/img — takedown (moderation kit)", () => {
  it("451s a hidden author before any cache or network work", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: truthy binding so the guard runs
    (env as any).DB = {};
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await GET({
      request: new Request(`http://127.0.0.1:3000/img/${DID}/${CID}`),
      params: { did: DID, cid: CID },
    });
    expect(res.status).toBe(451);
    expect(await res.text()).toBe("This content is unavailable");
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
