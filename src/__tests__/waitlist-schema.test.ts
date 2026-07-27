import { describe, expect, it } from "vitest";

import { waitlistPayload } from "../lib/waitlist-schema";

describe("waitlistPayload", () => {
  it("accepts a plain email with empty honeypot", () => {
    expect(
      waitlistPayload.safeParse({ email: "a@b.co", gr_extra: "" }).success,
    ).toBe(true);
    expect(waitlistPayload.safeParse({ email: "a@b.co" }).success).toBe(true);
  });

  it("rejects invalid emails", () => {
    for (const email of ["", "nope", "a@", "@b.co", "a b@c.co"]) {
      expect(waitlistPayload.safeParse({ email }).success).toBe(false);
    }
  });

  it("rejects bots that fill the honeypot", () => {
    expect(
      waitlistPayload.safeParse({ email: "a@b.co", gr_extra: "Acme" }).success,
    ).toBe(false);
  });

  it("rejects overlong emails", () => {
    const email = `${"x".repeat(250)}@b.co`;
    expect(waitlistPayload.safeParse({ email }).success).toBe(false);
  });
});

describe("waitlistPayload normalization", () => {
  it("trims and lowercases before validating", () => {
    const r = waitlistPayload.safeParse({ email: "  A@B.CO  " });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.email).toBe("a@b.co");
  });
});
