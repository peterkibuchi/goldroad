// @vitest-environment node
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";

import {
  identFromFields,
  readerEmailPayload,
} from "../lib/reader-email-schema";
import { insertReaderEmail } from "../lib/reader-emails";

/**
 * The `reader_emails` write and the payload that reaches it, pinned in the SQL
 * and in the schema rather than through a live D1 (the .toSQL() pattern
 * drafts.test.ts and backup.test.ts already use).
 *
 * The property under test is idempotence, and it is a security property rather
 * than a convenience: if a duplicate raised, the endpoint would answer one way
 * for an address a writer already holds and another way for one they don't,
 * which tells anyone who asks whether a given reader reads a given writer.
 */
// Build-only drizzle instance; .toSQL() never touches the (empty) client.
// biome-ignore lint/suspicious/noExplicitAny: no live D1 needed to build SQL
const db = drizzle({} as any);

const WRITER = "did:plc:fake2222222222writer2222";

describe("insertReaderEmail", () => {
  const { sql, params } = insertReaderEmail(db, {
    email: "reader@example.com",
    writerDid: WRITER,
    source: "post",
  }).toSQL();

  it("writes the address, the writer and the surface", () => {
    expect(sql).toContain("reader_emails");
    expect(params).toContain("reader@example.com");
    expect(params).toContain(WRITER);
    expect(params).toContain("post");
  });

  it("is a no-op on a duplicate rather than an error", () => {
    expect(sql.toLowerCase()).toContain("on conflict do nothing");
  });

  it("stamps the consent timestamp itself", () => {
    // The column records WHEN the reader consented, so it can't be optional and
    // it can't come from the client.
    expect(sql).toContain("consented_at");
    expect(params.some((value) => typeof value === "number")).toBe(true);
  });
});

describe("readerEmailPayload", () => {
  const valid = {
    email: "reader@example.com",
    writerDid: WRITER,
    source: "post",
  };

  it("lowercases and trims the address at the door", () => {
    // (writer_did, email) is a unique key, so a key that only dedupes
    // exact-case addresses is not a duplicate check at all.
    const parsed = readerEmailPayload.parse({
      ...valid,
      email: "  Reader@Example.COM ",
    });
    expect(parsed.email).toBe("reader@example.com");
  });

  it("bounds the address at the RFC ceiling", () => {
    expect(
      readerEmailPayload.safeParse({
        ...valid,
        email: `${"a".repeat(250)}@example.com`,
      }).success,
    ).toBe(false);
  });

  it("insists the controller is a DID", () => {
    for (const writerDid of ["writer.example", "", "did:", "plc:abc"]) {
      expect(
        readerEmailPayload.safeParse({ ...valid, writerDid }).success,
      ).toBe(false);
    }
  });

  it("accepts only the two surfaces that exist", () => {
    expect(readerEmailPayload.safeParse(valid).success).toBe(true);
    expect(
      readerEmailPayload.safeParse({ ...valid, source: "publication" }).success,
    ).toBe(true);
    expect(
      readerEmailPayload.safeParse({ ...valid, source: "sidebar" }).success,
    ).toBe(false);
  });

  it("rejects a filled honeypot", () => {
    expect(
      readerEmailPayload.safeParse({ ...valid, gr_extra: "bot" }).success,
    ).toBe(false);
    expect(
      readerEmailPayload.safeParse({ ...valid, gr_extra: "" }).success,
    ).toBe(true);
  });

  it("stores nothing the form decorates itself with", () => {
    // `ident` and the Turnstile token ride along on the request; neither is part
    // of the row, so neither survives the parse.
    const parsed = readerEmailPayload.parse({
      ...valid,
      ident: "writer.example",
      turnstileToken: "tok",
    });
    expect(Object.keys(parsed).sort()).toEqual([
      "email",
      "source",
      "writerDid",
    ]);
  });
});

describe("identFromFields", () => {
  it("passes a handle and a DID through", () => {
    expect(identFromFields({ ident: "writer.example" })).toBe("writer.example");
    expect(identFromFields({ ident: WRITER })).toBe(WRITER);
  });

  it("drops anything that could steer a redirect", () => {
    for (const ident of [
      "//evil.example/phish",
      "/\\evil.example",
      "https://evil.example",
      "../../etc",
      "",
    ]) {
      expect(identFromFields({ ident })).toBeUndefined();
    }
  });

  it("drops a missing or non-string field", () => {
    expect(identFromFields({})).toBeUndefined();
    expect(identFromFields({ ident: 7 })).toBeUndefined();
    expect(identFromFields(null)).toBeUndefined();
  });
});
