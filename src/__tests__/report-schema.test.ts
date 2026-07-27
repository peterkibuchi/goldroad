// @vitest-environment node
import { describe, expect, it } from "vitest";

import { reportPayload } from "../lib/report-schema";

describe("reportPayload", () => {
  const base = {
    url: "https://trygoldroad.com/@writer.example/3lyk73wxnok2f",
    reason: "This post is not authorized to use my artwork.",
  };

  it("accepts a minimal valid report (no email)", () => {
    expect(reportPayload.safeParse({ ...base, gr_extra: "" }).success).toBe(
      true,
    );
  });

  it("accepts an optional email, lowercased and trimmed", () => {
    const parsed = reportPayload.safeParse({
      ...base,
      email: "  Reporter@Example.COM ",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.email).toBe("reporter@example.com");
  });

  it("accepts an empty email string (anonymous report)", () => {
    expect(reportPayload.safeParse({ ...base, email: "" }).success).toBe(true);
  });

  it("rejects a missing/blank url or reason", () => {
    expect(reportPayload.safeParse({ ...base, url: "" }).success).toBe(false);
    expect(reportPayload.safeParse({ ...base, reason: "  " }).success).toBe(
      false,
    );
  });

  it("rejects a filled honeypot", () => {
    expect(reportPayload.safeParse({ ...base, gr_extra: "spam" }).success).toBe(
      false,
    );
  });

  it("rejects an oversized reason (D1-stuffing guard)", () => {
    expect(
      reportPayload.safeParse({ ...base, reason: "x".repeat(2001) }).success,
    ).toBe(false);
  });
});
