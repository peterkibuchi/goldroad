/**
 * Minimal atproto public-read helpers — no auth, no AppView.
 * Rendering one publication needs only: handle → DID → PDS → getRecord.
 */
import { readBodyCapped } from "~/lib/blob";
import { defaultCache } from "~/lib/workers-cache";

const HANDLE_RE =
  /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
const DID_RE = /^did:(plc:[a-z2-7]{24}|web:[a-zA-Z0-9._:%-]+)$/;

export type Handle = `${string}.${string}`;
export type Did = `did:${string}:${string}`;

export function isHandle(s: string): s is Handle {
  return s.length <= 253 && HANDLE_RE.test(s);
}

export function isDid(s: string): s is Did {
  return DID_RE.test(s);
}

/**
 * SSRF guard for fetches to attacker-influenced hosts: did:web hostnames and
 * PDS serviceEndpoints lifted from DID documents. On deployed Workers the
 * blast radius is minimal (no internal network), but local dev runs on a
 * laptop where localhost services exist — that's what this guards.
 *
 * Accepts only https:// on the default port, to a public-looking DNS name:
 * no userinfo, no IP literals (IPv4 in any dotted form, bracketed IPv6),
 * no single-label hosts (covers localhost + bare-integer/hex IP encodings),
 * no *.localhost. Trailing dots are normalized away before the checks so
 * "localhost." can't slip past, and the returned URL uses the normalized host.
 */
export function assertPublicHttpsUrl(urlString: string): URL {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new NotFoundError(`invalid URL: ${urlString}`);
  }
  if (url.protocol !== "https:")
    throw new NotFoundError(`refusing non-https URL: ${urlString}`);
  if (url.port !== "")
    throw new NotFoundError(`refusing explicit port: ${urlString}`);
  if (url.username !== "" || url.password !== "")
    throw new NotFoundError(`refusing userinfo in URL: ${urlString}`);
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (
    host === "" ||
    host.startsWith("[") || // IPv6 literal
    /^[\d.]+$/.test(host) || // IPv4 literal, incl. shortened forms like 127.1
    /^0x[0-9a-f.]+$/.test(host) || // hex-encoded IPv4
    !host.includes(".") || // single-label: localhost, intranet names, bare-int IPs
    host.endsWith(".localhost")
  ) {
    throw new NotFoundError(`refusing non-public host: ${urlString}`);
  }
  url.hostname = host;
  return url;
}

/**
 * Every read in this module talks to a host the *subject* chose: a `did:web`
 * document is a static file on any web server, so an unauthenticated request
 * for `/@did:web:evil.example/<rkey>` makes us fetch whatever that server
 * serves. Two bounds apply to all of it.
 */

/** A slow server must not hold a render open. Matches the import path's budget. */
const FETCH_TIMEOUT_MS = 10_000;

/** Ceiling for one atproto JSON response, so a hostile host can't exhaust
 * memory. A DID document is a fraction of it; a `listRecords` page of long
 * documents can pass it, which listRecordsPage handles. */
const MAX_JSON_BYTES = 1_000_000;

/** fetch() for the URLs above: never follow redirects (a public host could
 * otherwise bounce us to an internal one), and never wait forever. res.ok
 * stays false for 3xx. */
function fetchPublic(url: URL): Promise<Response> {
  // redirect:"manual", not "error" — "error" throws inconsistently on workerd.
  return fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

/**
 * `res.json()` with a hard byte cap — never call it directly on these hosts.
 * Buffering an unbounded body is how a hostile PDS exhausts the isolate, which
 * is the rule `~/lib/blob` already states and this module had not followed.
 *
 * Returns null when the body is oversized or isn't JSON; callers treat that the
 * same as a missing record, because to a reader it is one.
 */
async function readJsonCapped<T>(res: Response): Promise<T | null> {
  const bytes = await readBodyCapped(res, MAX_JSON_BYTES);
  return bytes ? parseJson<T>(bytes) : null;
}

function parseJson<T>(bytes: Uint8Array): T | null {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

/**
 * How long reader routes reuse a resolved identity from the edge cache. On a
 * cold reading page, handle → DID → PDS is two round trips, one after the
 * other, before the writer's repo can be asked for anything. The takedown
 * check is keyed on the DID, so no cached answer can get around it.
 *
 * A handle is kept for ten minutes: it can pass to another account, and until
 * the entry expires the page would show the previous holder's posts under it.
 * A PDS is kept for an hour, the usual atproto resolver default, because a
 * move is caught sooner than that: a PDS that refuses a writer's repo sends
 * the reader route back for a fresh answer (see refreshReaderPds).
 */
export const HANDLE_CACHE_TTL_SECONDS = 600;
export const PDS_CACHE_TTL_SECONDS = 3600;

const identityCacheUrl = (key: string) =>
  `https://goldroad-identity.internal/v1/${key}`;

/** Not awaited: the store is local to the data center and nothing reads it
 * back during this request, so it has no business on the critical path. The
 * request outlives it, since the page still has its PDS reads ahead of it. */
function storeIdentity(key: string, value: string, ttlSeconds: number): void {
  defaultCache()
    ?.put(
      identityCacheUrl(key),
      new Response(value, {
        headers: { "cache-control": `public, s-maxage=${ttlSeconds}` },
      }),
    )
    .catch(() => {});
}

/**
 * `resolve()` through the Workers Cache. Only successes are stored, and a
 * stored value is re-checked with `accept` on the way out, so a corrupt entry
 * costs a fresh resolution rather than a bad fetch. Without a cache (unit
 * tests, the browser) this is just `resolve()`.
 *
 * Budget: a reading page resolves at most one handle and one DID, so this adds
 * four Cache API calls on a cold page (two lookups, two stores) and saves two
 * fetches on every warm one. A fully cold post page comes to about 20 of the
 * 50 subrequests, counting every cache call and D1 query.
 */
async function cachedIdentity(
  key: string,
  ttlSeconds: number,
  accept: (value: string) => boolean,
  resolve: () => Promise<string>,
): Promise<string> {
  const hit = await defaultCache()
    ?.match(identityCacheUrl(key))
    .catch(() => undefined);
  const cached = await hit?.text().catch(() => null);
  if (cached && accept(cached)) return cached;
  const value = await resolve();
  storeIdentity(key, value, ttlSeconds);
  return value;
}

/** Handle → DID via the AppView, cached for HANDLE_CACHE_TTL_SECONDS. Every
 * caller is a reader route. */
export async function resolveHandleToDid(handle: string): Promise<Did> {
  const key = `handle/${encodeURIComponent(handle.toLowerCase())}`;
  return (await cachedIdentity(key, HANDLE_CACHE_TTL_SECONDS, isDid, () =>
    resolveHandleUncached(handle),
  )) as Did;
}

async function resolveHandleUncached(handle: string): Promise<Did> {
  const res = await fetch(
    `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`,
    { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
  );
  if (!res.ok) throw new NotFoundError(`handle ${handle} did not resolve`);
  const did = (await readJsonCapped<{ did: string }>(res))?.did ?? "";
  if (!isDid(did)) throw new NotFoundError("resolved DID is malformed");
  return did;
}

type DidDocument = {
  alsoKnownAs?: string[];
  service?: Array<{ id: string; type: string; serviceEndpoint: string }>;
};

async function fetchDidDocument(did: string): Promise<DidDocument> {
  // did:web hostnames are attacker-chosen — validate before fetching.
  const url = assertPublicHttpsUrl(
    did.startsWith("did:plc:")
      ? `https://plc.directory/${did}`
      : `https://${did.slice("did:web:".length).split(":")[0]}/.well-known/did.json`,
  );
  const res = await fetchPublic(url);
  if (!res.ok) throw new NotFoundError(`DID document for ${did} not found`);
  const doc = await readJsonCapped<DidDocument>(res);
  if (!doc) throw new NotFoundError(`DID document for ${did} was unreadable`);
  return doc;
}

function pdsFromDocument(doc: DidDocument, did: string): string {
  const pds = doc.service?.find(
    (s) =>
      s.type === "AtprotoPersonalDataServer" || s.id.endsWith("#atproto_pds"),
  )?.serviceEndpoint;
  if (!pds)
    throw new NotFoundError(`no PDS endpoint in DID document for ${did}`);
  // The endpoint comes from a user-controlled DID document — SSRF-guard it.
  return assertPublicHttpsUrl(pds).origin;
}

function handleFromDocument(doc: DidDocument, did: string): Handle {
  const aka = doc.alsoKnownAs?.find((u) => u.startsWith("at://"));
  const handle = aka?.slice("at://".length) ?? "";
  if (!isHandle(handle))
    throw new NotFoundError(`no handle in DID document for ${did}`);
  return handle;
}

function orNull<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

/** Both answers a DID document carries, for callers that want both. */
export type DidIdentity = { handle: Handle | null; pds: string | null };

/**
 * Resolve a DID's handle AND its PDS from ONE fetch of the DID document.
 *
 * Nearly every signed-in surface needs both — the handle to address the
 * writer, the PDS to read their repo — and resolving them separately fetched
 * the same document from plc.directory twice per page load, for one page's
 * worth of latency on somebody else's infrastructure.
 *
 * Null per field rather than a throw: every one of those callers already
 * treated its own resolution as best-effort, and an unreachable directory and
 * a document that names no PDS lead to exactly the same fallback.
 */
export async function resolveDidIdentity(did: string): Promise<DidIdentity> {
  let doc: DidDocument;
  try {
    doc = await fetchDidDocument(did);
  } catch {
    return { handle: null, pds: null };
  }
  return {
    handle: orNull(() => handleFromDocument(doc, did)),
    pds: orNull(() => pdsFromDocument(doc, did)),
  };
}

/** Resolve a DID to its PDS service endpoint via the DID document. Throws
 * (unlike resolveDidIdentity) — a reader route needs a NotFoundError to
 * distinguish "no such repo" from a directory that was merely unreachable. */
export async function resolveDidToPds(did: string): Promise<string> {
  return pdsFromDocument(await fetchDidDocument(did), did);
}

const pdsKey = (did: string) => `pds/${encodeURIComponent(did)}`;

/** resolveDidToPds for the public reading surfaces, cached for
 * PDS_CACHE_TTL_SECONDS. Signed-in surfaces keep resolving fresh: a reader or
 * writer who just moved PDS must not have their own repo read from the old
 * one. */
export async function resolveReaderPds(did: string): Promise<string> {
  return cachedIdentity(
    pdsKey(did),
    PDS_CACHE_TTL_SECONDS,
    // The SSRF guard again: a cached endpoint is trusted no more than a fresh one.
    (pds) => orNull(() => assertPublicHttpsUrl(pds).origin) === pds,
    () => resolveDidToPds(did),
  );
}

/**
 * For a reader route whose PDS just refused the writer's repo: resolves the DID
 * afresh and, if it now names a different PDS, stores and returns that one.
 * Null when nothing changed (or the directory can't be reached), which leaves
 * the refusal standing. A writer who moved PDS within the cached hour would
 * otherwise get 404s for the rest of it. On a genuinely missing repo this
 * costs one DID-document fetch, the same as before anything was cached.
 */
export async function refreshReaderPds(
  did: string,
  stale: string,
): Promise<string | null> {
  const fresh = await resolveDidToPds(did).catch(() => null);
  if (!fresh || fresh === stale) return null;
  storeIdentity(pdsKey(did), fresh, PDS_CACHE_TTL_SECONDS);
  return fresh;
}

/** Resolve a DID to its declared handle (`alsoKnownAs` at:// entry). UNVERIFIED
 * (display use only — a bidirectional check would re-resolve handle → DID). */
export async function resolveDidToHandle(did: string): Promise<Handle> {
  return handleFromDocument(await fetchDidDocument(did), did);
}

/** com.atproto.repo.getRecord entry: at:// URI + CID (a strongRef) + value.
 * `cid` is optional in the XRPC response shape, so callers must handle absence. */
export type RecordEntry<T> = { uri: string; cid?: string; value: T };

export async function getRecordEntry<T>(
  pds: string,
  did: string,
  collection: string,
  rkey: string,
): Promise<RecordEntry<T>> {
  const params = new URLSearchParams({ collection, repo: did, rkey });
  // Defense in depth: pds originates from a DID document (see resolveDidToPds).
  const url = assertPublicHttpsUrl(
    `${pds}/xrpc/com.atproto.repo.getRecord?${params}`,
  );
  const res = await fetchPublic(url);
  if (!res.ok)
    throw new NotFoundError(`record ${collection}/${rkey} not found`);
  // Untrusted network shape — reject non-object bodies before touching fields.
  const body: unknown = await readJsonCapped<unknown>(res);
  if (typeof body !== "object" || body === null)
    throw new NotFoundError(`record ${collection}/${rkey} is malformed`);
  const json = body as RecordEntry<T>;
  if (typeof json.value !== "object" || json.value === null)
    throw new NotFoundError(`record ${collection}/${rkey} has no value`);
  return {
    uri: typeof json.uri === "string" ? json.uri : "",
    cid: typeof json.cid === "string" ? json.cid : undefined,
    value: json.value,
  };
}

export async function getRecord<T>(
  pds: string,
  did: string,
  collection: string,
  rkey: string,
): Promise<T> {
  return (await getRecordEntry<T>(pds, did, collection, rkey)).value;
}

/** One entry from com.atproto.repo.listRecords. `value` is untrusted network data. */
export type ListedRecord<T> = { uri: string; cid: string; value: T };

export const MAX_LIST_RECORDS = 50;

/** Page size for the public archive. Each record carries its body twice
 * (markdown and plaintext), so a page of long essays is heavy to parse; a
 * page past the response cap is retried smaller (see listRecordsPage). */
export const LIST_PAGE_SIZE = 20;

/** The retry size when the oversized response didn't declare its length. */
const SMALL_PAGE_SIZE = 5;

/** A listRecords page that can't be read right now: the PDS is down, rate
 * limiting, or answered with something that isn't a listing. Thrown, never
 * returned as an empty page: "no posts" is a claim we can't make. */
export class ListUnavailableError extends Error {
  name = "ListUnavailableError";
}

/** A listRecords page over the response cap even after a smaller retry. Not
 * transient: the same records will be just as large next time. */
export class ResponseTooLargeError extends ListUnavailableError {
  name = "ResponseTooLargeError";
}

/** Pagination cursors are opaque PDS strings that round-trip through our own
 * search params — bound the length and reject control chars, nothing more.
 * (URLSearchParams encoding makes any accepted value safe in the XRPC URL.) */
export function isValidCursor(s: unknown): s is string {
  return (
    typeof s === "string" &&
    s.length > 0 &&
    s.length <= 512 &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control chars is the point
    !/[\x00-\x1f\x7f-\x9f]/.test(s)
  );
}

/** One page of com.atproto.repo.listRecords. `cursor` is non-null when the
 * PDS reports more records past this page — pass it back in `opts.cursor`. */
export type RecordsPage<T> = {
  records: ListedRecord<T>[];
  cursor: string | null;
};

/**
 * Public com.atproto.repo.listRecords against a PDS — no auth. Fetches a
 * single page, capped at MAX_LIST_RECORDS; `cursor` continues a previous
 * page. `reverse: true` = oldest first.
 *
 * Throws NotFoundError when the PDS refuses the listing (a 4xx: no such repo,
 * deactivated), ListUnavailableError when it can't answer usefully (5xx, 429,
 * a redirect, a body that isn't a listing), and ResponseTooLargeError when a
 * page stays over the response cap after one smaller retry.
 */
export async function listRecordsPage<T>(
  pds: string,
  did: string,
  collection: string,
  opts: { limit?: number; reverse?: boolean; cursor?: string } = {},
  retried = false,
): Promise<RecordsPage<T>> {
  const limit = Math.min(
    Math.max(opts.limit ?? MAX_LIST_RECORDS, 1),
    MAX_LIST_RECORDS,
  );
  const params = new URLSearchParams({
    collection,
    limit: String(limit),
    repo: did,
  });
  if (opts.reverse) params.set("reverse", "true");
  if (isValidCursor(opts.cursor)) params.set("cursor", opts.cursor);
  // Defense in depth: pds originates from a DID document (see resolveDidToPds).
  const url = assertPublicHttpsUrl(
    `${pds}/xrpc/com.atproto.repo.listRecords?${params}`,
  );
  const res = await fetchPublic(url);
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    // status 0 is the opaque response a manual redirect yields.
    const refused = res.status >= 400 && res.status < 500 && res.status !== 429;
    const message = `could not list ${collection} for ${did}: ${res.status}`;
    throw refused
      ? new NotFoundError(message)
      : new ListUnavailableError(message);
  }
  const declared = Number(res.headers.get("content-length"));
  const bytes = await readBodyCapped(res, MAX_JSON_BYTES);
  if (!bytes) {
    if (!retried && limit > 1) {
      // Size the retry from the declared length when there is one, with
      // headroom, so a long-form archive costs one retry, not a crawl.
      const fit =
        declared > 0
          ? Math.floor((limit * MAX_JSON_BYTES * 0.8) / declared)
          : SMALL_PAGE_SIZE;
      const smaller = Math.max(1, Math.min(fit, limit - 1));
      return listRecordsPage(
        pds,
        did,
        collection,
        { ...opts, limit: smaller },
        true,
      );
    }
    throw new ResponseTooLargeError(
      `${collection} page for ${did} is over ${MAX_JSON_BYTES} bytes`,
    );
  }
  const json = parseJson<{ records?: unknown; cursor?: unknown }>(bytes);
  if (!json || !Array.isArray(json.records))
    throw new ListUnavailableError(
      `${collection} listing for ${did} is not a listing`,
    );
  return {
    // Drop malformed entries instead of trusting the shape. `cid` is checked
    // too — the ListedRecord type promises it, and callers build strongRefs
    // from it (adopted from review: don't let the guard lie about the type).
    records: json.records.filter(
      (r): r is ListedRecord<T> =>
        typeof r === "object" &&
        r !== null &&
        typeof (r as ListedRecord<T>).uri === "string" &&
        typeof (r as ListedRecord<T>).cid === "string" &&
        typeof (r as ListedRecord<T>).value === "object" &&
        (r as ListedRecord<T>).value !== null,
    ),
    // A full page + a cursor = more to fetch. A short page means the PDS ran
    // out even if it echoed a cursor — don't offer an empty "older" page.
    cursor:
      isValidCursor(json.cursor) && json.records.length >= limit
        ? json.cursor
        : null,
  };
}

/** Pages an archive read walks at most. Four pages of fifty is two hundred
 * records — deep enough to cover any beta-era archive, bounded so a prolific
 * writer can't turn one page load into an unbounded PDS crawl. Surfaces that
 * hit the ceiling say so rather than presenting a page as the whole. */
export const MAX_ARCHIVE_PAGES = 4;

/**
 * Walks up to `maxPages` pages of one collection, oldest cursor first, and
 * reports whether the PDS still had more. Sequential by necessity — each page's
 * cursor comes from the previous response — and bounded by construction.
 */
export async function listRecordPages<T>(
  pds: string,
  did: string,
  collection: string,
  opts: { maxPages?: number } = {},
): Promise<{ records: ListedRecord<T>[]; truncated: boolean }> {
  const maxPages = Math.max(1, opts.maxPages ?? MAX_ARCHIVE_PAGES);
  const records: ListedRecord<T>[] = [];
  let cursor: string | undefined;
  let limit = MAX_LIST_RECORDS;
  for (let page = 0; page < maxPages; page++) {
    const result = await listRecordsPage<T>(pds, did, collection, {
      cursor,
      limit,
    });
    records.push(...result.records);
    if (result.cursor === null) return { records, truncated: false };
    // A short page with a cursor was shrunk to fit: ask for that size next,
    // rather than paying for the oversized request again.
    limit = Math.max(1, Math.min(limit, result.records.length));
    cursor = result.cursor;
  }
  return { records, truncated: true };
}

/** Single-page listRecords (no pagination) — see listRecordsPage. */
export async function listRecords<T>(
  pds: string,
  did: string,
  collection: string,
  opts: { limit?: number; reverse?: boolean } = {},
): Promise<ListedRecord<T>[]> {
  return (await listRecordsPage<T>(pds, did, collection, opts)).records;
}

/** Record-key syntax (atproto spec) — any collection, not just TID-keyed
 * ones. "." and ".." are reserved and rejected. */
export const RKEY_RE = /^(?!\.{1,2}$)[a-zA-Z0-9._:~-]{1,512}$/;

/** Last path segment of an at:// record URI — the rkey — or null. */
export function rkeyFromUri(uri: string): string | null {
  const rkey = uri.split("/").at(-1) ?? "";
  return RKEY_RE.test(rkey) ? rkey : null;
}

/** Parses an at:// record URI into its parts, or null if malformed.
 * Shape: at://<did>/<collection>/<rkey> — untrusted input, so every part
 * is validated (the authority may legally be a handle; we only accept DIDs
 * because our callers always follow up with a DID-based PDS resolution). */
export function parseAtUri(
  uri: string,
): { did: Did; collection: string; rkey: string } | null {
  if (!uri.startsWith("at://")) return null;
  const [did, collection, rkey, ...rest] = uri.slice("at://".length).split("/");
  if (rest.length > 0) return null;
  if (!did || !isDid(did)) return null;
  // NSID shape: ≥3 dot-separated segments, no empty segments, alpha first char
  // (rejects "c", "com..example", "com.example." — not the full grammar, but
  // enough for values we only ever equality-check or URL-encode into fetches).
  if (
    !collection ||
    collection.length > 317 ||
    !/^[a-zA-Z][a-zA-Z0-9-]*(\.[a-zA-Z0-9-]+){2,}$/.test(collection)
  )
    return null;
  if (!rkey || !RKEY_RE.test(rkey)) return null;
  return { did, collection, rkey };
}

export class NotFoundError extends Error {}

/** site.standard.document — metadata + plaintext lexicon. Field shapes match
 * @atcute/standard-site@2 (types/document); everything optional here because
 * network records are untrusted input. Read the body through
 * `documentBodyMarkdown` (~/lib/document-content) rather than off either field
 * directly — it knows which of the two is authoritative per record. */
export type StandardDocument = {
  $type?: string;
  title?: string;
  description?: string;
  /** Prepend to `site`'s URL (leading slash) for the canonical document URL. */
  path?: string;
  /** Publication record (at://) or publication URL (https://). */
  site?: string;
  publishedAt?: string;
  updatedAt?: string;
  tags?: string[];
  /** Plaintext representation of the document's contents — per the lexicon,
   * free of markdown. True of what we write; older records (ours and other
   * apps') hold markdown here instead, which is why the body is read through
   * documentBodyMarkdown and not from here. */
  textContent?: string;
  /** Open content union: `at.markpub.markdown` is the body's source of truth,
   * any other format (e.g. pub.leaflet.content) makes the document read-only
   * for us. See ~/lib/document-content. */
  content?: unknown;
  /** strongRef to the Bluesky post announcing this document (lexicon: "Strong
   * reference to a Bluesky post") — our announce write-back target. Untrusted. */
  bskyPostRef?: { uri?: unknown; cid?: unknown };
  /** Cover/thumbnail image blob (lexicon: image/*, ≤1MB). Untrusted shape —
   * validate with isBlobObject (~/lib/blob) before dereferencing. */
  coverImage?: unknown;
  /** Inline body-image blobs (our own field — see DocumentRecord in
   * ~/lib/publish for why the record has to carry them). Untrusted shape;
   * inlineImagesForBody validates every entry. */
  goldroadInlineImages?: unknown;
};

/** site.standard.publication — untrusted network shape, fields optional.
 * Typed shapes: @atcute/standard-site@2 (types/publication). */
export type StandardPublication = {
  $type?: string;
  /** Name of the publication. */
  name?: string;
  /** Brief description of the publication. */
  description?: string;
  /** Base publication URL; canonical document URL = url + document.path. */
  url?: string;
  /** Square identity image (lexicon: image/*, ≤1MB, ≥256×256) — untrusted
   * shape, validate with coverImageCid (~/lib/blob) before dereferencing. */
  icon?: unknown;
  /** Embedded site.standard.theme.basic — the author's four colours, written
   * by us or by any other app on the shared lexicon (Leaflet, pckt, Offprint).
   * Untrusted shape; validate with parseTheme (~/lib/theme) before applying. */
  basicTheme?: unknown;
};
