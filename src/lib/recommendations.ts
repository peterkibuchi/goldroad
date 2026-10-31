/**
 * Writer-curated recommendations: up to six publications a writer lists on
 * their own publication record, shown on their publication page.
 *
 * Stored as `goldroadRecommendations` on the writer's `site.standard.publication`.
 * The lexicon has no field for it, and `site.standard.graph.recommend`
 * recommends one document, not a publication, so this is a plain namespaced
 * property, like `goldroadInlineImages` on documents, rather than an NSID of
 * our own. The name is permanent public API and never changes. Its value is
 * an array of `{ uri }` objects, each a publication's AT-URI or an https
 * address. Objects rather than bare strings so an entry can gain a property
 * later without a new field.
 *
 * Writer-curated only, deliberately: the list is the writer's, in the
 * writer's order. Nothing here ranks, counts or records who followed a link.
 */

import type * as SiteStandardPublication from "@atcute/standard-site/types/publication";

import {
  getRecord,
  isDid,
  isHandle,
  listRecords,
  NotFoundError,
  parseAtUri,
  readWellKnownPublication,
  resolveHandleToDid,
  resolveReaderPds,
  type StandardPublication,
} from "~/lib/atproto";
import { publicationBase } from "~/lib/publish";

export const MAX_RECOMMENDATIONS = 6;

/** One stored entry. An object rather than a bare string so a later version
 * can add to an entry (a line on why, say) without a new field. */
export type StoredRecommendation = { uri: string };

const PUBLICATION_COLLECTION = "site.standard.publication";

/** Longest URL an entry may hold. Generous for any real address, and it keeps
 * six entries from bloating the record. */
const MAX_URI_LENGTH = 2000;

/**
 * Is this a value a recommendation may point at: a publication record's
 * AT-URI, or an absolute https URL with nothing a page couldn't link to?
 */
export function isRecommendationUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_URI_LENGTH) return false;
  if (value.startsWith("at://")) {
    return parseAtUri(value)?.collection === PUBLICATION_COLLECTION;
  }
  return httpsUrl(value) !== null;
}

/** An absolute https URL with a dotted host and no credentials, normalized,
 * or null. Only https: a reading page never links a reader to plain http. */
function httpsUrl(value: string): string | null {
  if (/\s/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  if (!url.hostname.includes(".")) return null;
  return url.toString();
}

/**
 * A list of candidate URIs, cleaned: entries that aren't valid are dropped,
 * duplicates collapse to the first, and anything past six is ignored.
 */
export function cleanRecommendationUris(values: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (out.length === MAX_RECOMMENDATIONS) break;
    if (isRecommendationUri(value) && !out.includes(value)) out.push(value);
  }
  return out;
}

/**
 * The stored list, read from an untrusted record field. Every read and every
 * write goes through here (the write rebuilds the field from it), so the page
 * and the record always agree on what the list is.
 */
export function recommendationUris(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return cleanRecommendationUris(
    value.map((entry) =>
      typeof entry === "object" && entry !== null
        ? (entry as { uri?: unknown }).uri
        : undefined,
    ),
  );
}

/** The record field for a cleaned list: absent when it is empty, so a writer
 * who removes every entry looks like one who never added any. */
export function recommendationsField(
  uris: readonly string[],
): StoredRecommendation[] | undefined {
  const clean = cleanRecommendationUris(uris);
  return clean.length > 0 ? clean.map((uri) => ({ uri })) : undefined;
}

/**
 * Sets (or clears) the list on an existing publication record, preserving
 * every other field: the same merge `withBasicTheme` (~/lib/publish) does, for
 * the same reason. The list is rebuilt from `uris` every time, never merged
 * with what the record held, so an entry the writer removed is gone.
 */
export function withRecommendations(
  existing: StandardPublication,
  uris: readonly string[],
): SiteStandardPublication.Main {
  if (typeof existing.name !== "string" || existing.name.trim() === "")
    throw new Error("publication has no name");
  if (
    typeof existing.url !== "string" ||
    !/^https?:\/\/\S+$/.test(existing.url)
  )
    throw new Error("publication has no valid url");
  return {
    ...existing,
    $type: "site.standard.publication",
    goldroadRecommendations: recommendationsField(uris),
  } as SiteStandardPublication.Main;
}

/** What the page shows for one recommendation. */
export type RecommendationCard = {
  uri: string;
  name: string;
  description: string | null;
  /** Where the link goes: the publication's own site, or this site's page
   * for its author when it names none we can link to. */
  href: string;
  /** The address, quietly, so a reader knows where the link leads; "" when
   * the publication names none. */
  host: string;
};

/** How long one recommendation may take to resolve. A slow server costs its
 * own card, never the page: past this, the card is left out. */
export const RECOMMENDATION_TIMEOUT_MS = 2500;

const NAME_LIMIT = 200;
const DESCRIPTION_LIMIT = 300;

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

/** A host and path for display: "writer.leaflet.pub", "example.com/blog". */
function displayAddress(href: string): string {
  const url = new URL(href);
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.hostname.replace(/^www\./, "")}${path}`;
}

/** The card for a plain web address: nothing to read, so the address names
 * it. */
function websiteCard(uri: string): RecommendationCard {
  const address = displayAddress(uri);
  return { uri, name: address, description: null, href: uri, host: address };
}

async function publicationCard(
  uri: string,
  timeoutMs: number,
): Promise<RecommendationCard | null> {
  const parsed = parseAtUri(uri);
  if (!parsed) return null;
  const pds = await resolveReaderPds(parsed.did);
  const record = await getRecord<StandardPublication>(
    pds,
    parsed.did,
    parsed.collection,
    parsed.rkey,
    { timeoutMs },
  );
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!name) return null;
  const description =
    typeof record.description === "string" ? record.description.trim() : "";
  const base = publicationBase({ publicationUrl: record.url });
  const href = base ?? `/@${encodeURIComponent(parsed.did)}`;
  return {
    uri,
    name: clip(name, NAME_LIMIT),
    description: description ? clip(description, DESCRIPTION_LIMIT) : null,
    href,
    // No address to show rather than a DID: identifiers aren't for readers.
    host: base ? displayAddress(base) : "",
  };
}

/** Resolves to null after `ms`, so a race against it bounds the wait. */
function deadline(ms: number): Promise<null> {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms));
}

/**
 * The cards for a stored list, in the writer's order, all at once. An entry
 * that can't be read, or doesn't answer within the timeout, is left out of
 * this render; the list itself is untouched, so it is back on the next one.
 *
 * Budget: a plain address costs nothing. A publication costs its author's PDS
 * lookup (cached for an hour, see resolveReaderPds) and one record read, so
 * six of them add at most about two dozen subrequests to a cold page and
 * about a dozen to a warm one, and the reading page's own cache keeps even
 * that to once every few minutes per data center.
 */
export async function resolveRecommendations(
  uris: readonly string[],
  timeoutMs = RECOMMENDATION_TIMEOUT_MS,
): Promise<Array<RecommendationCard | null>> {
  return Promise.all(
    uris.map((uri) =>
      uri.startsWith("at://")
        ? Promise.race([
            publicationCard(uri, timeoutMs).catch(() => null),
            deadline(timeoutMs),
          ])
        : websiteCard(uri),
    ),
  );
}

/** Why an address couldn't be added. */
export type AddProblem =
  | "unrecognised"
  | "no_account"
  | "no_publication"
  | "unreachable";

/**
 * What a writer typed into "Add a publication" → the entry to store.
 *
 * Writers know addresses, not AT-URIs, so this accepts what they have: a
 * handle (with or without the @), a profile link on Bluesky or on a reading
 * page here, a publication's own web address, or an AT-URI. Anything that
 * leads to a standard.site publication is stored as that publication's
 * AT-URI, which keeps working if its address changes and lets the page show
 * its name and description. Any other https address is stored as itself.
 *
 * A web address is matched to a publication only when its site says so, at
 * the standard.site well-known path, and the record it names agrees on the
 * address. A site can't claim a publication that isn't its own.
 */
export async function resolveRecommendationInput(
  input: string,
  ownOrigins: readonly string[],
): Promise<{ ok: true; uri: string } | { ok: false; problem: AddProblem }> {
  const text = input.trim();
  if (text.startsWith("at://")) {
    return isRecommendationUri(text)
      ? { ok: true, uri: text }
      : { ok: false, problem: "unrecognised" };
  }
  const handle = text.replace(/^@/, "");
  if (isHandle(handle) && !text.includes("/")) {
    const found = await authorPublication(handle);
    // A bare domain is a valid handle and a valid address at once. Only an
    // "@" says which was meant; without one, a name no account answers to
    // is taken as the website.
    if (found.ok || text.startsWith("@") || found.problem !== "no_account")
      return found;
  }
  const url = httpsUrl(text) ?? httpsUrl(`https://${text}`);
  if (!url) return { ok: false, problem: "unrecognised" };
  const parsed = new URL(url);
  const author = profileIdent(parsed, ownOrigins);
  if (author) return authorPublication(author);
  const claimed = await claimedPublication(parsed);
  return { ok: true, uri: claimed ?? url };
}

/** The handle or DID a profile link names: a reading page here
 * (`/@ident`) or a Bluesky profile (`bsky.app/profile/ident`). */
function profileIdent(url: URL, ownOrigins: readonly string[]): string | null {
  const ours = ownOrigins.includes(url.origin);
  const match = ours
    ? /^\/@([^/]+)\/?$/.exec(url.pathname)
    : url.hostname === "bsky.app"
      ? /^\/profile\/([^/]+)\/?$/.exec(url.pathname)
      : null;
  if (!match) return null;
  const ident = decodeURIComponent(match[1]);
  return isHandle(ident) || isDid(ident) ? ident : null;
}

/** An author's publication: the oldest one in their repo, the same record
 * their reading page here is named after. */
async function authorPublication(
  ident: string,
): Promise<{ ok: true; uri: string } | { ok: false; problem: AddProblem }> {
  let did: string;
  try {
    did = isDid(ident) ? ident : await resolveHandleToDid(ident);
  } catch (err) {
    return {
      ok: false,
      problem: err instanceof NotFoundError ? "no_account" : "unreachable",
    };
  }
  try {
    const pds = await resolveReaderPds(did);
    const pubs = await listRecords<StandardPublication>(
      pds,
      did,
      PUBLICATION_COLLECTION,
      { limit: 1, reverse: true },
    );
    const uri = pubs[0]?.uri;
    return isRecommendationUri(uri) && parseAtUri(uri)?.did === did
      ? { ok: true, uri }
      : { ok: false, problem: "no_publication" };
  } catch (err) {
    return {
      ok: false,
      problem: err instanceof NotFoundError ? "no_publication" : "unreachable",
    };
  }
}

/**
 * The publication a site claims at standard.site's well-known path, when the
 * record agrees: its `url` must be the address the writer gave, or the start
 * of it. Null for a site that claims none, claims one that disagrees, or
 * can't be read; the address is then stored as a plain website.
 */
async function claimedPublication(url: URL): Promise<string | null> {
  const uri = await readWellKnownPublication(url).catch(() => null);
  const parsed = uri ? parseAtUri(uri) : null;
  if (!uri || parsed?.collection !== PUBLICATION_COLLECTION) return null;
  try {
    const pds = await resolveReaderPds(parsed.did);
    const record = await getRecord<StandardPublication>(
      pds,
      parsed.did,
      parsed.collection,
      parsed.rkey,
    );
    const base = publicationBase({ publicationUrl: record.url });
    const given = url.toString().replace(/\/+$/, "");
    return base && (given === base || given.startsWith(`${base}/`))
      ? uri
      : null;
  } catch {
    return null;
  }
}
