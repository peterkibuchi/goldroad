// @vitest-environment node
import { describe, expect, it } from "vitest";

import { SCOPES } from "../lib/oauth-scopes";

/**
 * The scope strings are part of the auth contract: the client metadata, the
 * PAR request, and the consent screen all derive from them. Pin them exactly —
 * a drive-by "cleanup" here silently changes what writers consent to, and
 * pre-existing sessions keep the old grant until re-login (see the
 * insufficient-scope handling in /api/publish).
 */
describe("OAuth scopes", () => {
  it("pins the exact scope strings", () => {
    expect(SCOPES).toEqual([
      "repo?collection=site.standard.document&collection=site.standard.publication&action=create&action=update&action=delete",
      "repo?collection=app.bsky.feed.post&action=create",
      "blob?accept=image/*",
    ]);
  });

  it("grants delete only on site.standard.* — announce posts are create-only", () => {
    const bskyScope = SCOPES.find((s) => s.includes("app.bsky.feed.post"));
    expect(bskyScope).toBeDefined();
    expect(bskyScope).not.toContain("delete");
    expect(bskyScope).not.toContain("update");
  });

  it("never requests wildcard collections (prohibited by atproto authz servers)", () => {
    for (const s of SCOPES.filter((s) => s.startsWith("repo")))
      expect(s).not.toContain("*");
  });

  it("blob uploads are limited to images — never arbitrary file types", () => {
    const blobScope = SCOPES.find((s) => s.startsWith("blob"));
    expect(blobScope).toBe("blob?accept=image/*");
  });
});
