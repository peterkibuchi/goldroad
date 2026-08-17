// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/subscribe — the reader email-capture endpoint.
 *
 * It is the second write an anonymous visitor is meant to reach, so what these
 * tests pin is the posture /api/waitlist established, held here too: a body cap
 * that refuses before anything is parsed, a honeypot, a Turnstile gate that
 * blocks the insert when the secret is set, and ONE indistinguishable refusal for
 * every tripwire. Plus the two properties that are this endpoint's own:
 *
 *   - a duplicate is a plain success, because an endpoint that answered
 *     differently for an address it already holds would tell anyone whether a
 *     given reader reads a given writer;
 *   - a submit without JavaScript is a browser form post, so its answer has to be
 *     a page the browser can render rather than a JSON body — and the address
 *     must never travel in the redirect it gets.
 */
const insertedValues = vi.fn();
const conflictHandled = vi.fn();
vi.mock("drizzle-orm/d1", () => ({
  drizzle: () => ({
    insert: () => ({
      values: (row: unknown) => {
        insertedValues(row);
        return {
          onConflictDoNothing: () => {
            conflictHandled();
            return Promise.resolve();
          },
        };
      },
    }),
  }),
}));

import { Route } from "../routes/api.subscribe";
import { env } from "./mocks/cloudflare-workers";
import { handlerOf } from "./support/route-handler";

const post = handlerOf(Route, "POST");

const WRITER = "did:plc:fake2222222222writer2222";

const BODY = {
  email: "reader@example.com",
  writerDid: WRITER,
  source: "post",
  ident: "writer.example",
  gr_extra: "",
};

function json(body: unknown, raw?: string): Promise<Response> {
  return Promise.resolve(
    post({
      request: new Request("https://trygoldroad.com/api/subscribe", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.9",
        },
        body: raw ?? JSON.stringify(body),
      }),
    }),
  );
}

function form(fields: Record<string, string>): Promise<Response> {
  return Promise.resolve(
    post({
      request: new Request("https://trygoldroad.com/api/subscribe", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "cf-connecting-ip": "203.0.113.9",
        },
        body: new URLSearchParams(fields).toString(),
      }),
    }),
  );
}

function stubSiteverify(success: boolean) {
  const fetcher = vi.fn(
    async () =>
      new Response(JSON.stringify({ success }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

beforeEach(() => {
  insertedValues.mockClear();
  conflictHandled.mockClear();
});

afterEach(() => {
  delete env.TURNSTILE_SECRET;
  vi.unstubAllGlobals();
});

describe("/api/subscribe — the address it stores", () => {
  it("accepts a reader and stores the writer, the surface and nothing else", async () => {
    const res = await json(BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(insertedValues).toHaveBeenCalledWith({
      email: "reader@example.com",
      writerDid: WRITER,
      source: "post",
    });
  });

  it("normalizes the address before it becomes half of a unique key", async () => {
    // Case and stray whitespace decide whether the (writer, email) key is a real
    // duplicate check: Reader@Example.com and reader@example.com must be one row.
    await json({ ...BODY, email: "  Reader@Example.COM " });
    expect(insertedValues).toHaveBeenCalledWith(
      expect.objectContaining({ email: "reader@example.com" }),
    );
  });

  it("lets a duplicate succeed silently rather than answering differently", async () => {
    // The write is the idempotent form, so an address this writer already holds
    // and one they don't produce the same 200 — no enumeration oracle.
    const res = await json(BODY);
    expect(res.status).toBe(200);
    expect(conflictHandled).toHaveBeenCalledTimes(1);
  });

  it("keeps the reader's address out of the analytics-free response entirely", async () => {
    const body = JSON.stringify(await (await json(BODY)).json());
    expect(body).not.toContain("reader@example.com");
  });
});

describe("/api/subscribe — the guards, all answering alike", () => {
  it("refuses an oversized body without parsing it", async () => {
    // Well past the cap, and valid JSON — so whatever rejects it is the cap
    // rather than the parser.
    const huge = JSON.stringify({
      ...BODY,
      email: `${"a".repeat(200_000)}@example.com`,
    });
    const parse = vi.spyOn(JSON, "parse");
    const res = await json(null, huge);
    expect(res.status).toBe(400);
    expect(
      parse.mock.calls.some(([text]) => String(text).length > 100_000),
      "the oversized body must never reach JSON.parse",
    ).toBe(false);
    expect(insertedValues).not.toHaveBeenCalled();
    parse.mockRestore();
  });

  it("refuses a malformed body the same way", async () => {
    const res = await json(null, "not json");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "invalid" });
    expect(insertedValues).not.toHaveBeenCalled();
  });

  it("refuses a filled honeypot before the insert", async () => {
    const res = await json({ ...BODY, gr_extra: "bot was here" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "invalid" });
    expect(insertedValues).not.toHaveBeenCalled();
  });

  it("refuses an address that isn't one, and an over-long one", async () => {
    for (const email of ["reader", "reader@", "", `${"a".repeat(250)}@b.com`]) {
      expect((await json({ ...BODY, email })).status).toBe(400);
    }
    expect(insertedValues).not.toHaveBeenCalled();
  });

  it("refuses anything but a DID as the writer", async () => {
    // The controller of the address arrives from the client, so its shape is the
    // one thing about it we can insist on.
    for (const writerDid of [
      "writer.example",
      "",
      "https://evil.example",
      WRITER.replace("did:", ""),
    ]) {
      expect((await json({ ...BODY, writerDid })).status).toBe(400);
    }
    expect(insertedValues).not.toHaveBeenCalled();
  });

  it("refuses a surface it doesn't recognize", async () => {
    for (const source of ["homepage", "", "POST"]) {
      expect((await json({ ...BODY, source })).status).toBe(400);
    }
    expect(insertedValues).not.toHaveBeenCalled();
  });
});

describe("/api/subscribe — Turnstile, when the secret is set", () => {
  it("stores without a token when no secret is configured (feature off)", async () => {
    const fetcher = stubSiteverify(false);
    expect((await json(BODY)).status).toBe(200);
    expect(insertedValues).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses a token-less submit before any insert", async () => {
    env.TURNSTILE_SECRET = "test-secret";
    stubSiteverify(true);
    const res = await json(BODY);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "invalid" });
    expect(insertedValues).not.toHaveBeenCalled();
  });

  it("refuses a token siteverify rejects, with the same body", async () => {
    env.TURNSTILE_SECRET = "test-secret";
    stubSiteverify(false);
    const res = await json({ ...BODY, turnstileToken: "tok" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "invalid" });
    expect(insertedValues).not.toHaveBeenCalled();
  });

  it("accepts a verified token and forwards the connecting IP", async () => {
    env.TURNSTILE_SECRET = "test-secret";
    const fetcher = stubSiteverify(true);
    expect((await json({ ...BODY, turnstileToken: "tok" })).status).toBe(200);
    expect(insertedValues).toHaveBeenCalledTimes(1);
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.body as URLSearchParams).get("remoteip")).toBe("203.0.113.9");
  });
});

describe("/api/subscribe — a submit from a browser with no JavaScript", () => {
  it("stores a plain form post and sends the reader to a page, not a JSON body", async () => {
    const res = await form({
      email: "reader@example.com",
      writerDid: WRITER,
      source: "publication",
      ident: "writer.example",
      gr_extra: "",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/subscribed?to=writer.example");
    expect(insertedValues).toHaveBeenCalledWith({
      email: "reader@example.com",
      writerDid: WRITER,
      source: "publication",
    });
  });

  it("never puts the address in the redirect it hands the browser", async () => {
    // A query string lands in history, in referrer headers and in server logs.
    const res = await form({
      email: "reader@example.com",
      writerDid: WRITER,
      source: "post",
      ident: "writer.example",
      gr_extra: "",
    });
    expect(res.headers.get("location")).not.toContain("reader");
    expect(res.headers.get("location")).not.toContain("%40");
  });

  it("hands a refusal a page too, marked as having saved nothing", async () => {
    const res = await form({
      email: "not-an-address",
      writerDid: WRITER,
      source: "post",
      ident: "writer.example",
      gr_extra: "",
    });
    expect(res.status).toBe(303);
    // `failed=true`, not `failed=1`: the router parses search values before
    // /subscribed reads them, so a `1` arrives as a number and a flag spelled
    // that way reads as absent — which rendered a refusal as a confirmation.
    expect(res.headers.get("location")).toBe(
      "/subscribed?to=writer.example&failed=true",
    );
    expect(insertedValues).not.toHaveBeenCalled();
  });

  it("builds that page's link back from a vetted identifier, never a free path", async () => {
    // `ident` is a form field, and a form field that becomes a URL is how open
    // redirects happen. A value that isn't a handle or a DID is dropped — and
    // dropped rather than fatal, so a tampered decoration doesn't cost a reader
    // the address they meant to leave.
    const res = await form({
      email: "reader@example.com",
      writerDid: WRITER,
      source: "post",
      ident: "//evil.example/phish",
      gr_extra: "",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/subscribed");
    expect(insertedValues).toHaveBeenCalledTimes(1);
  });

  it("keeps the way back on a refusal, so a reader isn't stranded", async () => {
    // A refusal a reader can't leave is a dead end: the page they came from is
    // named even when the submit never got as far as validation.
    const res = await form({
      email: "not-an-address",
      writerDid: WRITER,
      source: "post",
      ident: "writer.example",
      gr_extra: "",
    });
    expect(res.headers.get("location")).toContain("to=writer.example");
  });
});
