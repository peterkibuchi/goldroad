/**
 * /api/waitlist body cap.
 *
 * This is the one write endpoint an anonymous visitor is meant to reach, and
 * the Turnstile check runs *after* the body is parsed — so the cap is the only
 * thing standing between the open internet and an unbounded buffered read.
 * Every sibling endpoint already capped; this one didn't.
 */
import { describe, expect, it, vi } from "vitest";

// Route files read Workers bindings at module scope; the `cloudflare:workers`
// alias in vitest.config.ts stubs them for this import.
import { Route } from "../routes/api.waitlist";

type Handlers = {
  POST: (ctx: { request: Request }) => Promise<Response>;
};
const post = (Route.options.server as { handlers: Handlers }).handlers.POST;

function request(body: string): Request {
  return new Request("https://example.test/api/waitlist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

describe("/api/waitlist body cap", () => {
  it("refuses an oversized body without parsing it", async () => {
    // Well past the cap, and valid JSON — so anything that rejects it is the
    // cap rather than the parser.
    const huge = JSON.stringify({
      email: `${"a".repeat(200_000)}@example.com`,
    });
    const parse = vi.spyOn(JSON, "parse");

    const res = await post({ request: request(huge) });

    expect(res.status).toBe(400);
    expect(
      parse.mock.calls.some(([text]) => String(text).length > 100_000),
      "the oversized body must never reach JSON.parse",
    ).toBe(false);
    parse.mockRestore();
  });

  it("still refuses a malformed small body the same way", async () => {
    // Same 400 as every other tripwire on this endpoint: a bot learns nothing
    // about which check caught it.
    const res = await post({ request: request("not json") });
    expect(res.status).toBe(400);
  });
});
