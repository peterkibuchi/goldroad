/**
 * Subscribing to a publication — `site.standard.graph.subscription`.
 *
 * THE SHAPE IS THE ARGUMENT. A subscription is a record in the SUBSCRIBER'S own
 * repository pointing at a publication's AT-URI. It is not a row in our
 * database, and it is not a follower list we hold on a writer's behalf. Nobody
 * needs our permission to keep it, move it, or read it — which is the same
 * reason theming lives in the writer's repo (~/lib/theme) rather than ours.
 *
 * A shared lexicon, already in the dependency tree, needing no domain of ours.
 * Leaflet, pckt and Offprint read the same shape, so a reader who subscribes
 * here is subscribed there too.
 *
 * WHAT THIS DELIBERATELY IS NOT. It is not an email list. There is no address
 * here and no consent to collect, because nothing is being sent — a
 * subscription is a declaration of interest that the reader publishes about
 * themselves. Email is a separate thing with separate obligations, and
 * conflating the two is how a list ends up mailed without permission.
 *
 * THE LIMIT, STATED SO IT IS NOT REDISCOVERED. Writing these is easy; COUNTING
 * them is not. "Every repo holding a subscription that points at this
 * publication" is a reverse lookup the protocol does not offer — it needs a
 * firehose indexer, which on Cloudflare means a connection the free tier cannot
 * hold. So a writer sees no subscriber total from this yet. The records
 * accumulate from the first day regardless, and any later indexer backfills
 * them, which is why shipping it now is worth more than waiting.
 */
import { isResourceUri, type ResourceUri } from "@atcute/lexicons";
import type * as SiteStandardGraphSubscription from "@atcute/standard-site/types/graph/subscription";

/** The collection these records live in. One spelling, one place. */
export const SUBSCRIPTION_COLLECTION = "site.standard.graph.subscription";

/**
 * Is this an AT-URI?
 *
 * The lexicon package's own guard rather than a regex of ours: it knows the
 * grammar, and it narrows to the branded type the record field actually wants —
 * one less place to be subtly wrong about somebody else's spec, and one less
 * cast at the write door.
 */
export function isAtUri(value: unknown): value is ResourceUri {
  return isResourceUri(value);
}

/**
 * The record to write when a reader subscribes.
 *
 * `createdAt` is optional in the lexicon and we always set it: a subscription
 * with no date cannot be ordered, and "when did this reader arrive" is the one
 * question a writer will eventually want answered about their own audience.
 */
export function subscriptionRecord(
  publicationAtUri: ResourceUri,
  createdAt: string,
): SiteStandardGraphSubscription.Main {
  return {
    $type: SUBSCRIPTION_COLLECTION,
    publication: publicationAtUri,
    createdAt,
  };
}

/**
 * Does this record — read off any repo, ours or a stranger's — subscribe to the
 * given publication?
 *
 * Defensive because the input is a record from somebody else's PDS: a
 * non-object, a missing field, a number where a URI belongs. Anything that is
 * not a matching AT-URI is simply not a match, which is the same "invalid means
 * absent" rule `parseTheme` follows.
 */
export function subscribesTo(
  record: unknown,
  publicationAtUri: string,
): boolean {
  if (typeof record !== "object" || record === null) return false;
  const publication = (record as { publication?: unknown }).publication;
  return isAtUri(publication) && publication === publicationAtUri;
}

/**
 * The reader's existing subscription to this publication, if they have one.
 *
 * Takes the records already listed from their repo rather than fetching, so the
 * page's single read serves both "is the button on or off" and nothing else —
 * and so this stays a pure function with no network in a unit test.
 *
 * Returns the rkey, because unsubscribing needs it: deleting a subscription is
 * `deleteRecord` on that key, and a reader may hold several subscriptions.
 */
export function findSubscription(
  records: ReadonlyArray<{ uri: string; value: unknown }>,
  publicationAtUri: string,
  rkeyOf: (uri: string) => string | null,
): string | null {
  for (const record of records) {
    if (!subscribesTo(record.value, publicationAtUri)) continue;
    // The URI is validated before a key is taken out of it, and the collection
    // has to be the subscription one. `rkeyFromUri` reads the last path
    // segment, which for a malformed uri is the whole string — and that string
    // can satisfy the rkey grammar, so an unchecked uri would hand us a
    // plausible key pointing at nothing we meant. The delete would fail at the
    // PDS rather than do damage, but a control whose "unsubscribe" cannot work
    // should read as unsubscribed instead of lying.
    if (!isAtUri(record.uri)) continue;
    if (!record.uri.includes(`/${SUBSCRIPTION_COLLECTION}/`)) continue;
    const rkey = rkeyOf(record.uri);
    if (rkey) return rkey;
  }
  return null;
}
