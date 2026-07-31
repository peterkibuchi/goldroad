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

import { OAuthResolverError } from "@atcute/oauth-node-client";

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
    // What @atcute's authorize() actually throws when the identity can't be
    // resolved — the one failure class where "check the handle" is the truth.
    authorize.mockRejectedValue(
      new OAuthResolverError("failed to resolve identity: ghost.bsky.social"),
    );
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

  it("maps non-resolution authorize() failures to signin_unavailable, never handle_not_found", async () => {
    // A PAR push / client-metadata / state-store failure is OUR problem — the
    // handle resolved fine; sending the writer to respell it is misdirection.
    authorize.mockRejectedValue(new Error("PAR request failed: 500"));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await post({
        handle: "writer.bsky.social",
        returnTo: "/write",
      });
      expect(res.status).toBe(303);
      const location = locationOf(res);
      expect(location.searchParams.get("error")).toBe("signin_unavailable");
      expect(location.searchParams.get("handle")).toBe("writer.bsky.social");
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
    expect(safeReturnTo("//evil.example")).toBe("/home");
    expect(safeReturnTo("https://evil.example")).toBe("/home");
    expect(safeReturnTo("javascript:alert(1)")).toBe("/home");
  });

  it("falls back on a backslash authority, which browsers treat as a slash", () => {
    // Under the WHATWG URL Standard a backslash is equivalent to a slash in the
    // authority position, so this resolves cross-origin exactly like
    // "//evil.example" while reading as a path.
    expect(
      new URL("/\\evil.example", "https://trygoldroad.com/oauth/callback").href,
    ).toBe("https://evil.example/");
    expect(safeReturnTo("/\\evil.example")).toBe("/home");
    expect(safeReturnTo("/\\\\evil.example")).toBe("/home");
  });

  it("refuses every hostile shape regardless of the fallback offered", () => {
    // The refusal is the guard; the fallback is only where a refusal lands.
    // Changing the default must never turn a rejected value into an accepted
    // one, so the whole refusal set is re-run against an explicit fallback.
    for (const hostile of [
      "//evil.example",
      "https://evil.example",
      "http://evil.example",
      "javascript:alert(1)",
      "/\\evil.example",
      "/\\\\evil.example",
      "",
      "write",
      "?next=/write",
      null,
      undefined,
      42,
      { toString: () => "/write" },
    ]) {
      expect(safeReturnTo(hostile, "/settings")).toBe("/settings");
      expect(safeReturnTo(hostile)).toBe("/home");
    }
  });

  it("still allows a path whose later segments contain a backslash", () => {
    // Only the authority position is dangerous; a backslash deeper in the path
    // is just a character, and refusing it would be superstition.
    expect(safeReturnTo("/write/a\\b")).toBe("/write/a\\b");
  });

  it("falls back on non-strings, honoring the given fallback", () => {
    expect(safeReturnTo(null)).toBe("/home");
    expect(safeReturnTo(undefined, "/dashboard")).toBe("/dashboard");
  });
});

/**
 * Where a plain sign-in lands. The overview documents itself as the surface a
 * signed-in writer lands on; the fallback used to say /write, so a sign-in that
 * named no destination dropped the writer into a blank editor. These pin the
 * agreement, in both directions.
 */
describe("sign-in landing", () => {
  it("sends a writer who named no destination to the overview", () => {
    expect(safeReturnTo(undefined)).toBe("/home");
    expect(safeReturnTo("")).toBe("/home");
  });

  it("still honors an explicit /write — the editor's own sign-in panel", () => {
    expect(safeReturnTo("/write")).toBe("/write");
    expect(safeReturnTo("/write?draft=abc123")).toBe("/write?draft=abc123");
  });

  it("carries the destination through the POST that starts sign-in", async () => {
    authorize.mockResolvedValue({
      url: new URL("https://pds.example/authorize?request_uri=fake"),
    });
    await post({ handle: "writer.bsky.social", returnTo: "/stats" });
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { type: "account", identifier: "writer.bsky.social" },
        state: { returnTo: "/stats" },
      }),
    );
  });

  it("falls back to the overview when the POST names no destination", async () => {
    authorize.mockResolvedValue({
      url: new URL("https://pds.example/authorize?request_uri=fake"),
    });
    await post({ handle: "writer.bsky.social" });
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { type: "account", identifier: "writer.bsky.social" },
        state: { returnTo: "/home" },
      }),
    );
  });

  it("refuses a hostile destination on the way in, landing on the overview", async () => {
    authorize.mockResolvedValue({
      url: new URL("https://pds.example/authorize?request_uri=fake"),
    });
    await post({
      handle: "writer.bsky.social",
      returnTo: "//evil.example/phish",
    });
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { type: "account", identifier: "writer.bsky.social" },
        state: { returnTo: "/home" },
      }),
    );
  });

  it("keeps the destination on the way back from a failed attempt", async () => {
    // A writer bounced here from /stats who then mistypes their handle must not
    // be quietly rerouted: the panel re-posts what it is handed.
    const res = await post({ handle: "not_a_handle", returnTo: "/stats" });
    expect(locationOf(res).searchParams.get("returnTo")).toBe("/stats");
  });

  it("never echoes a hostile destination back into the sign-in form", async () => {
    const res = await post({
      handle: "not_a_handle",
      returnTo: "//evil.example",
    });
    expect(locationOf(res).searchParams.get("returnTo")).toBe("/home");
  });

  it("tells the panel nothing when the form named no destination", async () => {
    // Absent, not "/home": /write is the panel's own default, and a writer who
    // came to the editor to write should stay headed there.
    const res = await post({ handle: "not_a_handle" });
    expect(locationOf(res).searchParams.get("returnTo")).toBeNull();
  });
});
