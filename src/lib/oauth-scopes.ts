/**
 * The OAuth scope Goldroad requests — separate from ~/lib/oauth so tests can
 * import it without pulling in `cloudflare:workers`.
 *
 * NO wildcards in repo scopes — they are prohibited by the atproto authz
 * servers. The library prepends the base `atproto` scope automatically.
 *
 * Actions are explicit (the spec's omitted-`action` default is "all
 * operations", but implicit grants are how scope creep hides). `delete`
 * powers the dashboard delete flow; `app.bsky.feed.post` create powers
 * "Announce on Bluesky"; the blob scope powers com.atproto.repo.uploadBlob
 * for cover images — images only, never arbitrary files.
 *
 * SCOPE-CHANGE CAVEAT: tokens carry the scope granted at consent time —
 * sessions created before a scope addition can't use the new permission until
 * the writer signs in again (the insufficient-scope error paths in
 * /api/publish surface a re-connect prompt instead of failing opaquely).
 * The blob scope was added 2026-07-24: sessions from before it can't upload
 * covers until re-login.
 */
import { scope } from "@atcute/oauth-node-client";

export const SCOPES = [
  scope.repo({
    collection: ["site.standard.document", "site.standard.publication"],
    action: ["create", "update", "delete"],
  }),
  scope.repo({
    collection: ["app.bsky.feed.post"],
    action: ["create"],
  }),
  scope.blob({ accept: ["image/*"] }),
];
