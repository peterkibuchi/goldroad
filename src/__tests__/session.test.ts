// @vitest-environment node
// (node, not jsdom: these helpers need WebCrypto's crypto.subtle, like workerd)
import { describe, expect, it } from "vitest";

import {
  readSessionDid,
  sessionClearCookie,
  sessionSetCookie,
  signSession,
  verifySessionToken,
} from "../lib/session";

// Deliberately patterned, low-entropy fixture — random-looking hex here trips
// secret scanners (GitGuardian) even when fake. Never use a real key in tests.
const SECRET = "test-cookie-secret-0123456789-not-a-real-key";
const DID = "did:plc:ukp7pzzht32uigg6bg4vxr5t";

describe("session token", () => {
  it("round-trips a DID through the signed {did, iat} payload", async () => {
    const token = await signSession(DID, SECRET);
    // Format is now `base64url(json).base64url(hmac)` — exactly one separator.
    expect(token.split(".")).toHaveLength(2);
    expect(await verifySessionToken(token, SECRET)).toBe(DID);
  });

  it("rejects a tampered payload (the DID is inside the signed payload)", async () => {
    const token = await signSession(DID, SECRET);
    const [payload, sig] = token.split(".");
    // Flip a payload char: the signature no longer matches.
    const forged = `${payload.slice(0, -1)}${payload.endsWith("A") ? "B" : "A"}.${sig}`;
    expect(await verifySessionToken(forged, SECRET)).toBeNull();
  });

  it("rejects a tampered signature", async () => {
    const token = await signSession(DID, SECRET);
    const flipped = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    expect(await verifySessionToken(flipped, SECRET)).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signSession(DID, "another-secret");
    expect(await verifySessionToken(token, SECRET)).toBeNull();
  });

  it("rejects garbage tokens without throwing", async () => {
    for (const bad of [
      "",
      ".",
      "no-dot",
      "did:plc:x.",
      ".sig",
      "a.!!!not-b64!!!",
    ])
      expect(await verifySessionToken(bad, SECRET)).toBeNull();
  });

  it("handles did:web DIDs containing dots", async () => {
    const didWeb = "did:web:example.com";
    const token = await signSession(didWeb, SECRET);
    expect(await verifySessionToken(token, SECRET)).toBe(didWeb);
  });

  it("throws when the secret is missing", async () => {
    await expect(signSession(DID, "")).rejects.toThrow("COOKIE_SECRET");
  });

  it("accepts a token within the 30-day TTL", async () => {
    const t0 = 1_700_000_000_000;
    const token = await signSession(DID, SECRET, t0);
    const day = 24 * 60 * 60 * 1000;
    expect(await verifySessionToken(token, SECRET, t0 + 29 * day)).toBe(DID);
  });

  it("rejects a token past the 30-day TTL (leaked-cookie replay window)", async () => {
    const t0 = 1_700_000_000_000;
    const token = await signSession(DID, SECRET, t0);
    const day = 24 * 60 * 60 * 1000;
    expect(await verifySessionToken(token, SECRET, t0 + 31 * day)).toBeNull();
  });

  it("rejects a future-dated token beyond clock skew", async () => {
    const t0 = 1_700_000_000_000;
    // Issued 10 min in the "future" relative to the verify clock.
    const token = await signSession(DID, SECRET, t0 + 10 * 60 * 1000);
    expect(await verifySessionToken(token, SECRET, t0)).toBeNull();
  });

  it("rejects legacy `did.HMAC(did)` tokens — plc AND dotted did:web (forces one re-login)", async () => {
    // Reconstruct the OLD format: payload = the raw DID, sig = HMAC(DID). The
    // did:web case matters: its dots put the lastIndexOf('.') split in a
    // different place, so pin that it still can't validate as a live session.
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    for (const legacyDid of [DID, "did:web:example.com"]) {
      const sig = await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(legacyDid),
      );
      const b64url = btoa(String.fromCharCode(...new Uint8Array(sig)))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
      const legacyToken = `${legacyDid}.${b64url}`;
      expect(
        await verifySessionToken(legacyToken, SECRET),
        legacyDid,
      ).toBeNull();
    }
  });
});

describe("session cookie", () => {
  it("reads a valid cookie from a request", async () => {
    const token = await signSession(DID, SECRET);
    const request = new Request("https://goldroad.example/write", {
      headers: { cookie: `other=1; gr_session=${token}; theme=dark` },
    });
    expect(await readSessionDid(request, SECRET)).toBe(DID);
  });

  it("returns null without a cookie header or with a forged value", async () => {
    expect(
      await readSessionDid(new Request("https://goldroad.example/"), SECRET),
    ).toBeNull();
    const forged = new Request("https://goldroad.example/", {
      headers: { cookie: `gr_session=${DID}.forgedsig` },
    });
    expect(await readSessionDid(forged, SECRET)).toBeNull();
  });

  it("emits HttpOnly/SameSite=Lax attributes and toggles Secure", () => {
    const set = sessionSetCookie("tok", true);
    expect(set).toContain("gr_session=tok");
    expect(set).toContain("HttpOnly");
    expect(set).toContain("Secure");
    expect(set).toContain("SameSite=Lax");
    expect(set).toContain("Path=/");
    expect(sessionSetCookie("tok", false)).not.toContain("Secure");
    expect(sessionClearCookie(true)).toContain("Max-Age=0");
  });
});
