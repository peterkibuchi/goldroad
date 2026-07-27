// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /login handler behavior: every way sign-in can fail to start must land the
 * browser back on the /write sign-in panel with a designed error code — never
 * a bare text/plain 400 (the owner hit that one in prod). The OAuth client is
 * mocked (it needs Workers bindings); handle normalization, validation, and
 * redirect shaping are the real handler code.
 */
const authorize = vi.fn();
vi.mock("~/lib/oauth", async (importOriginal) => {
  // Only the client factory is mocked (it needs Workers bindings and a live
  // PDS); everything else — safeReturnTo included — stays the REAL module,
  // so this suite exercises the actual open-redirect guard, not a copy.
  const actual = await importOriginal<typeof import("~/lib/oauth")>();
  return { ...actual, createOAuthClient: () => ({ authorize }) };
});

import { safeReturnTo } from "~/lib/oauth";
import { Route } from "../routes/login";

type Handler = (ctx: { request: Request }) => Promise<Response> | Response;
const handlers = (
  Route.options as unknown as {
    server: { handlers: { GET: Handler; POST: Handler } };
  }
).server.handlers;

function get(qs: string) {
  return handlers.GET({
    request: new Request(`http://127.0.0.1:3000/login${qs}`),
  });
}

function post(fields: Record<string, string>) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.append(key, value);
  return handlers.POST({
    request: new Request("http://127.0.0.1:3000/login", {
      method: "POST",
      body,
    }),
  });
}

function locationOf(res: Response): URL {
  return new URL(res.headers.get("location") ?? "", "http://127.0.0.1:3000");
}

beforeEach(() => {
  authorize.mockReset();
});

describe("/login — designed failure redirects", () => {
  it("303s a malformed handle back to /write with the error and the entered handle", async () => {
    const res = await get("?handle=not_a_handle");
    expect(res.status).toBe(303);
    const location = locationOf(res);
    expect(location.pathname).toBe("/write");
    expect(location.searchParams.get("error")).toBe("invalid_handle");
    expect(location.searchParams.get("handle")).toBe("not_a_handle");
    expect(authorize).not.toHaveBeenCalled();
  });

  it("POST gets the same redirect (the sign-in form posts)", async () => {
    const res = await post({ handle: "not_a_handle", returnTo: "/write" });
    expect(res.status).toBe(303);
    expect(locationOf(res).searchParams.get("error")).toBe("invalid_handle");
  });

  it("303s an unresolvable (but well-formed) handle with its own code", async () => {
    authorize.mockRejectedValue(new Error("handle did not resolve"));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await post({
        handle: "ghost.bsky.social",
        returnTo: "/write",
      });
      expect(res.status).toBe(303);
      const location = locationOf(res);
      expect(location.searchParams.get("error")).toBe("handle_not_found");
      expect(location.searchParams.get("handle")).toBe("ghost.bsky.social");
    } finally {
      quiet.mockRestore();
    }
  });

  it("bare /login (nothing entered) lands on the sign-in panel, no error", async () => {
    const res = await get("");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/write");
  });

  it("GET with a valid handle prefills /write but never starts OAuth (audit #8)", async () => {
    const res = await get("?handle=@writer.bsky.social");
    expect(res.status).toBe(303);
    const location = locationOf(res);
    expect(location.pathname).toBe("/write");
    expect(location.searchParams.get("handle")).toBe("writer.bsky.social");
    expect(location.searchParams.get("error")).toBeNull();
    // The load-bearing assertion: no handle resolution, no D1 state write, no
    // PAR push on an unauthenticated GET.
    expect(authorize).not.toHaveBeenCalled();
  });

  it("clips absurdly long junk to the handle grammar's length cap", async () => {
    const res = await get(`?handle=${"ab_".repeat(200)}`);
    expect(locationOf(res).searchParams.get("handle")?.length).toBe(253);
  });

  it("still starts the OAuth flow for a valid handle, @ and whitespace stripped", async () => {
    authorize.mockResolvedValue({
      url: new URL("https://pds.example/authorize?request_uri=fake"),
    });
    const res = await post({
      handle: " @writer.bsky.social ",
      returnTo: "/dashboard",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://pds.example/authorize?request_uri=fake",
    );
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { type: "account", identifier: "writer.bsky.social" },
        state: { returnTo: "/dashboard" },
      }),
    );
  });

  it("keeps rejecting a non-form POST body with a plain 400", async () => {
    const res = await handlers.POST({
      request: new Request("http://127.0.0.1:3000/login", {
        method: "POST",
        body: "not a form",
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("safeReturnTo — the real open-redirect guard", () => {
  it("allows same-site absolute paths only", () => {
    expect(safeReturnTo("/dashboard")).toBe("/dashboard");
    expect(safeReturnTo("/write?edit=abc")).toBe("/write?edit=abc");
  });

  it("falls back on protocol-relative and absolute URLs", () => {
    expect(safeReturnTo("//evil.example")).toBe("/write");
    expect(safeReturnTo("https://evil.example")).toBe("/write");
    expect(safeReturnTo("javascript:alert(1)")).toBe("/write");
  });

  it("falls back on non-strings, honoring the given fallback", () => {
    expect(safeReturnTo(null)).toBe("/write");
    expect(safeReturnTo(undefined, "/dashboard")).toBe("/dashboard");
  });
});
