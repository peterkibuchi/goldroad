import { createFileRoute } from "@tanstack/react-router";

import { isDid, parseAtUri, resolveDidToHandle } from "~/lib/atproto";
import { readBodyCapped } from "~/lib/blob";
import { canonicalOrigin } from "~/lib/origin";
import {
  purgeLocalReadCache,
  READ_CACHE_TTL_SECONDS,
  readSurfaceUrlsForSubject,
} from "~/lib/read-cache";
import { env } from "cloudflare:workers";

/**
 * Cache-purge hook for takedowns — the other half of a `hidden_content` row.
 *
 * WHY THIS EXISTS. The reader pages check the hide list inside their loader, and
 * a read-cache HIT returns stored bytes without running the loader at all (see
 * ~/lib/read-cache). Inserting the row is therefore only half of an urgent
 * takedown: until the entry expires, the page keeps serving. That was survivable
 * while the TTL was 60 s. It is not at 300 s, so the purge stopped being an
 * operational nicety and became the thing that holds the SLA up.
 *
 * The takedown tooling lives outside this repo, so the hook has to be something
 * it can call: one authenticated POST naming the same subjects the hide list
 * stores.
 *
 * WHAT A PURGE HONESTLY IS HERE, in two stages that are reported separately
 * because they succeed separately:
 *
 * 1. **Local.** `caches.default.delete` — instant, free, no token, and
 *    per-data-center: Cloudflare documents that it "only purges content of the
 *    cache in the data center that the Worker was invoked". So this evicts in
 *    ONE colo, whichever one answered this request. It is not a global purge and
 *    this route never calls it one.
 * 2. **Zone-wide.** The Cloudflare REST purge endpoint, which is the only global
 *    path and needs an API token. Gated on CF_PURGE_ZONE_ID + CF_PURGE_API_TOKEN:
 *    unset means the response says `"unconfigured"` rather than reporting a
 *    success the operator does not have. A record subject purges by URL; a bare
 *    DID purges everything, because an author's document pages cannot be
 *    enumerated without listing their repo (and their `?cursor=` archive pages
 *    cannot be enumerated at all) — for a legal takedown, dropping the zone's
 *    cache is the correct trade against leaving those pages served.
 *
 * With neither stage configured the residual exposure is READ_CACHE_TTL_SECONDS,
 * which the response states outright so nobody has to infer it.
 *
 * Auth is a bearer token, compared in constant time (see constantTimeEquals).
 * With TAKEDOWN_PURGE_TOKEN unset the route 404s — an unconfigured deployment
 * (every self-host) exposes no purge surface at all, rather than one guarded by
 * an empty string.
 */

/** A purge request is a short list of identifiers. */
const MAX_BODY_BYTES = 8_192;

/** Subjects per request. A takedown addresses a person or a post, not a corpus;
 * a caller with more has a loop, and each call stays cheap and auditable. */
const MAX_SUBJECTS = 20;

/** URLs per Cloudflare purge call — their documented ceiling is 100 per
 * request, so longer lists are chunked rather than silently truncated. */
const MAX_URLS_PER_PURGE_CALL = 100;

const PURGE_API_TIMEOUT_MS = 10_000;

/** Indistinguishable refusal: a caller without the token learns only that it
 * was refused, never whether the token was wrong or the body was. */
const DENIED = () => new Response("Not found", { status: 404 });

/**
 * Constant-time compare, hand-rolled on purpose. `crypto.subtle.timingSafeEqual`
 * is a Workers extension that does not exist under vitest, which would leave the
 * auth path on a moderation endpoint untestable; `node:crypto` would be the only
 * node builtin any route in this app pulls in. Six lines and a loop is the
 * cheaper answer than either.
 *
 * Length is compared first, and non-secretly: how LONG a token is leaks nothing
 * worth having, whereas which BYTE differs does.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

/** Bearer-token gate. An unset secret refuses everything — it must never become
 * an empty-string password. */
function isAuthorized(request: Request): boolean {
  const secret = env.TAKEDOWN_PURGE_TOKEN;
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  return constantTimeEquals(header.slice(prefix.length), secret);
}

/** Subjects, exactly as `hidden_content.subject` stores them: a bare DID or an
 * `at://` record URI. Anything else is dropped — a purge that silently guessed
 * at a malformed subject would report success for URLs nobody is serving. */
function parseSubjects(body: unknown): string[] {
  if (typeof body !== "object" || body === null) return [];
  const raw = (body as { subjects?: unknown }).subjects;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is string => typeof s === "string")
    .filter((s) => isDid(s) || parseAtUri(s) !== null)
    .slice(0, MAX_SUBJECTS);
}

type ZoneResult =
  | { status: "unconfigured" }
  | { status: "purged"; scope: "files" | "everything" }
  | { status: "failed"; detail: string };

/**
 * The one global purge path. `purgeEverything` is for author-level subjects,
 * whose pages are not enumerable — see the module doc for why that trade is the
 * right one for a legal takedown.
 */
async function purgeZone(
  urls: readonly string[],
  purgeEverything: boolean,
): Promise<ZoneResult> {
  const zone = env.CF_PURGE_ZONE_ID;
  const token = env.CF_PURGE_API_TOKEN;
  if (!zone || !token) return { status: "unconfigured" };

  const bodies: object[] = purgeEverything
    ? [{ purge_everything: true }]
    : chunk(urls, MAX_URLS_PER_PURGE_CALL).map((files) => ({ files }));
  if (bodies.length === 0) return { status: "purged", scope: "files" };

  for (const body of bodies) {
    let res: Response;
    try {
      res = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zone)}/purge_cache`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(PURGE_API_TIMEOUT_MS),
        },
      );
    } catch (err) {
      // Reported, never thrown: the local purge already happened and the caller
      // needs to know precisely which half worked.
      return { status: "failed", detail: `request failed: ${String(err)}` };
    }
    if (!res.ok) return { status: "failed", detail: `HTTP ${res.status}` };
  }
  return {
    status: "purged",
    scope: purgeEverything ? "everything" : "files",
  };
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

export const Route = createFileRoute("/api/cache-purge")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthorized(request)) return DENIED();

        const bytes = await readBodyCapped(request, MAX_BODY_BYTES);
        if (!bytes) return DENIED();
        let body: unknown;
        try {
          body = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          return DENIED();
        }
        const subjects = parseSubjects(body);
        if (subjects.length === 0) {
          return Response.json(
            { ok: false, error: "no_valid_subjects" },
            { status: 400 },
          );
        }

        // Cache keys are minted from the origin the page was SERVED on, so the
        // purge list has to use the same one: canonical in production, the
        // loopback origin in dev (~/lib/origin).
        const origin = canonicalOrigin(new URL(request.url).origin);

        // Both address forms of every page need purging, and the handle form
        // needs a resolution we cannot do from a pure function. Best-effort: a
        // directory that will not answer costs the handle-spelled URLs, which
        // then age out — it never fails the purge.
        const dids = [...new Set(subjects.map((s) => parseAtUri(s)?.did ?? s))];
        const handleByDid = new Map<string, string | null>(
          await Promise.all(
            dids.map(
              async (did) =>
                [did, await resolveDidToHandle(did).catch(() => null)] as const,
            ),
          ),
        );

        const urls = [
          ...new Set(
            subjects.flatMap((subject) =>
              readSurfaceUrlsForSubject(
                origin,
                subject,
                handleByDid.get(parseAtUri(subject)?.did ?? subject) ?? null,
              ),
            ),
          ),
        ];

        // An author-level subject is the unenumerable case — see purgeZone.
        const authorLevel = subjects.some((s) => isDid(s));
        const [localPurged, zone] = await Promise.all([
          purgeLocalReadCache(urls),
          purgeZone(urls, authorLevel),
        ]);

        return Response.json({
          ok: true,
          subjects: subjects.length,
          urls: urls.length,
          /** Keys evicted in THIS colo only — never a global count. */
          localPurged,
          zone,
          /** How long an un-purged copy elsewhere can still be served. */
          residualSeconds:
            zone.status === "purged" ? 0 : READ_CACHE_TTL_SECONDS,
        });
      },
    },
  },
});
