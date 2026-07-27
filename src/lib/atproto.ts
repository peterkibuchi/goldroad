/**
 * Minimal atproto public-read helpers — no auth, no AppView.
 * Rendering one publication needs only: handle → DID → PDS → getRecord.
 */

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

/** fetch() for the URLs above: never follow redirects (a public host could
 * otherwise bounce us to an internal one). res.ok stays false for 3xx. */
function fetchPublic(url: URL): Promise<Response> {
  // redirect:"manual", not "error" — "error" throws inconsistently on workerd.
  return fetch(url, { redirect: "manual" });
}

export async function resolveHandleToDid(handle: string): Promise<Did> {
  const res = await fetch(
    `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`,
  );
  if (!res.ok) throw new NotFoundError(`handle ${handle} did not resolve`);
  const { did } = (await res.json()) as { did: string };
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
  return (await res.json()) as DidDocument;
}

/** Resolve a DID to its PDS service endpoint via the DID document. */
export async function resolveDidToPds(did: string): Promise<string> {
  const doc = await fetchDidDocument(did);
  const pds = doc.service?.find(
    (s) =>
      s.type === "AtprotoPersonalDataServer" || s.id.endsWith("#atproto_pds"),
  )?.serviceEndpoint;
  if (!pds)
    throw new NotFoundError(`no PDS endpoint in DID document for ${did}`);
  // The endpoint comes from a user-controlled DID document — SSRF-guard it.
  return assertPublicHttpsUrl(pds).origin;
}

/** Resolve a DID to its declared handle (`alsoKnownAs` at:// entry). UNVERIFIED
 * (display use only — a bidirectional check would re-resolve handle → DID). */
export async function resolveDidToHandle(did: string): Promise<Handle> {
  const doc = await fetchDidDocument(did);
  const aka = doc.alsoKnownAs?.find((u) => u.startsWith("at://"));
  const handle = aka?.slice("at://".length) ?? "";
  if (!isHandle(handle))
    throw new NotFoundError(`no handle in DID document for ${did}`);
  return handle;
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
  const body: unknown = await res.json().catch(() => null);
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
 */
export async function listRecordsPage<T>(
  pds: string,
  did: string,
  collection: string,
  opts: { limit?: number; reverse?: boolean; cursor?: string } = {},
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
  if (!res.ok)
    throw new NotFoundError(`could not list ${collection} for ${did}`);
  const json = (await res.json()) as { records?: unknown; cursor?: unknown };
  if (!Array.isArray(json.records)) return { records: [], cursor: null };
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
 * network records are untrusted input. `content` is an open union (e.g.
 * pub.leaflet.content) we don't render yet; `textContent` is the plaintext body. */
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
  /** Plaintext representation of the document's contents. */
  textContent?: string;
  /** Open content union (e.g. pub.leaflet.content) — rich source of truth when present. */
  content?: unknown;
  /** strongRef to the Bluesky post announcing this document (lexicon: "Strong
   * reference to a Bluesky post") — our announce write-back target. Untrusted. */
  bskyPostRef?: { uri?: unknown; cid?: unknown };
  /** Cover/thumbnail image blob (lexicon: image/*, ≤1MB). Untrusted shape —
   * validate with isBlobObject (~/lib/blob) before dereferencing. */
  coverImage?: unknown;
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
};
