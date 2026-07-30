// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Origin gate on the two mutating handlers that used to skip it:
 * /api/publish (every PDS write, including deletes) and /logout.
 *
 * The OAuth client is mocked — it needs Workers bindings and a live PDS — so
 * these suites can assert the thing that matters: a cross-site POST is
 * refused BEFORE any session restore, revoke, or record write is attempted.
 * The check itself (isCrossSite) is unit-tested in origin.test.ts.
 */
const restore = vi.fn();
const revoke = vi.fn();
vi.mock("~/lib/oauth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/oauth")>();
  return { ...actual, createOAuthClient: () => ({ restore, revoke }) };
});

import { signSession } from "../lib/session";
import { Route as PublishRoute } from "../routes/api.publish";
import { Route as LogoutRoute } from "../routes/logout";

type Handler = (ctx: { request: Request }) => Promise<Response> | Response;
const handlerOf = (route: unknown): Handler =>
  (route as { options: { server: { handlers: { POST: Handler } } } }).options
    .server.handlers.POST;

const publish = handlerOf(PublishRoute);
const logout = handlerOf(LogoutRoute);

const DID = "did:plc:fake2222222222writer2222";
const SECRET = "vitest-fake-cookie-secret"; // mirrors mocks/cloudflare-workers

async function cookie(): Promise<string> {
  return `gr_session=${await signSession(DID, SECRET)}`;
}

/** A signed-in browser POSTing from an attacker's page: the session cookie
 * rides along (the scenario SameSite=Lax exists to stop), Origin does not. */
async function crossSite(path: string, body?: BodyInit): Promise<Request> {
  return new Request(`http://127.0.0.1:3000${path}`, {
    method: "POST",
    ...(body !== undefined ? { body } : {}),
    headers: { cookie: await cookie(), origin: "https://evil.example" },
  });
}

async function sameOrigin(path: string, body?: BodyInit): Promise<Request> {
  return new Request(`http://127.0.0.1:3000${path}`, {
    method: "POST",
    ...(body !== undefined ? { body } : {}),
    headers: { cookie: await cookie(), origin: "http://127.0.0.1:3000" },
  });
}

beforeEach(() => {
  restore.mockReset();
  revoke.mockReset();
});

describe("/api/publish — Origin gate", () => {
  it("403s a cross-site write and never restores the session", async () => {
    const form = new FormData();
    form.append("intent", "delete");
    const res = await publish({
      request: await crossSite("/api/publish", form),
    });
    expect(res.status).toBe(403);
    expect(restore).not.toHaveBeenCalled();
  });

  it("lets a same-origin write through the gate (it fails later, on the session)", async () => {
    restore.mockRejectedValue(new Error("no session in this test"));
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
    const form = new FormData();
    const res = await publish({
      request: await sameOrigin("/api/publish", form),
    });
    quiet.mockRestore();
    // Past the 403: the handler got as far as trying to restore the session.
    expect(res.status).not.toBe(403);
    expect(restore).toHaveBeenCalled();
  });
});

describe("/logout — Origin gate", () => {
  it("makes a cross-site sign-out inert: same 302, no cookie cleared, no revoke", async () => {
    const res = await logout({ request: await crossSite("/logout") });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    // The whole point: the session survives a forced sign-out attempt.
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(revoke).not.toHaveBeenCalled();
  });

  it("still signs out for real on a same-origin POST", async () => {
    revoke.mockResolvedValue(undefined);
    const res = await logout({ request: await sameOrigin("/logout") });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.get("set-cookie")).toContain("gr_session=;");
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(revoke).toHaveBeenCalledWith(DID);
  });

  it("signs out a request with no Origin header at all (non-browser client)", async () => {
    revoke.mockResolvedValue(undefined);
    const request = new Request("http://127.0.0.1:3000/logout", {
      method: "POST",
      headers: { cookie: await cookie() },
    });
    const res = await logout({ request });
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
