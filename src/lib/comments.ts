/**
 * The conversation under a post: the replies to the Bluesky post that
 * announced it, read from the PUBLIC AppView (app.bsky.feed.getPostThread)
 * unauthenticated — the same door ~/lib/engagement already knocks on, keyed
 * off the same announce write-back (StandardDocument.bskyPostRef).
 *
 * The point is that we do NOT own a comment system. There are no accounts to
 * create, nothing to store, nothing to moderate, and no spam queue to inherit;
 * the discussion already happened on the open network and this module just
 * reads it. That also fixes the failure mode: replies are a nice-to-have on a
 * reading page, so every single thing that can go wrong here — never
 * announced, malformed ref, upstream down, upstream slow, hostile body,
 * deleted root — resolves to `null` and the page renders without them. There
 * is no error state to design because there is no error surfaced.
 *
 * Shape verified 2026-08-17 against the published lexicons
 * (lexicons/app/bsky/feed/getPostThread.json + feed/defs.json + feed/
 * threadgate.json + actor/defs.json on bluesky-social/atproto@main): params
 * `uri` / `depth` / `parentHeight`; output `{ thread, threadgate }`, where
 * `thread` is a union of #threadViewPost | #notFoundPost | #blockedPost and
 * threadViewPost carries `post` (#postView) and `replies` (an array of that
 * same union).
 *
 * `threadgate` (#threadgateView) is the half this module used to ignore, and it
 * is not decoration: its `record` is the writer's own app.bsky.feed.threadgate,
 * whose `hiddenReplies` (at-uri array, maxLength 300) lists the replies THEY
 * chose to hide from their own thread. The AppView does not apply that choice
 * for us — measured 2026-08-17 across 370 busy public threads read
 * unauthenticated at depth 1: 12 carried a non-empty `hiddenReplies`, and 20 of
 * those 31 hidden URIs came back inside `thread.replies` anyway. Rendering them
 * would put words a writer deliberately removed from their thread back under
 * their article, on our surface, in their name. So we honour the gate here.
 *
 * Pure module — no `cloudflare:workers` import — so tests drive it directly;
 * the Workers Cache lookup is feature-detected via ~/lib/workers-cache, not
 * threaded through env.
 */
import { isHandle, parseAtUri } from "~/lib/atproto";
import { readBodyCapped } from "~/lib/blob";
import { APPVIEW_HOST, announcedPostUri, bskyPostUrl } from "~/lib/engagement";
import { defaultCache } from "~/lib/workers-cache";

/**
 * Deliberately shorter than ~/lib/engagement's 5 s. Replies are the least
 * important thing on a reading page, so they get the tightest leash: the call
 * runs concurrently with the PDS reads the page already makes, and 3 s caps
 * how far past those it can ever push first paint.
 */
const FETCH_TIMEOUT_MS = 3_000;

/**
 * Hard cap on the upstream body. Larger than engagement's 256 KB because a
 * thread response carries whole reply records, not four integers: a well-loved
 * post's direct replies run to a few hundred KB. Past this we return nothing
 * rather than spend the free tier's 10 ms CPU budget parsing it — a busy
 * thread losing its replies is a worse outcome than a quiet one, so the cap is
 * generous, but it is still a cap.
 */
const MAX_RESPONSE_BYTES = 524_288; // 512 KB

/**
 * One level of replies, no ancestors. This is the whole nesting policy: a
 * reading page wants the conversation, not a threading UI, and `depth: 1` is
 * also the cheapest useful request the lexicon offers. `parentHeight: 0`
 * because we already know the root — asking for 80 ancestors (the default)
 * would be bytes and CPU spent on data we throw away.
 */
const REPLY_DEPTH = 1;

/** How many replies the page renders. Past this the reader is sent to the
 * thread itself, which is better at being a thread than we are. */
export const MAX_RENDERED_REPLIES = 20;

/** app.bsky.feed.post caps `text` at 3000 characters. A record claiming more
 * is malformed or hostile; clamp rather than hand the layout an essay. */
const MAX_REPLY_TEXT_CHARS = 3000;

/** app.bsky.actor.defs#profileViewBasic caps `displayName` at 640 characters.
 * Beyond that we fall back to the handle instead of clamping — a 4 KB "name"
 * is not a name. */
const MAX_DISPLAY_NAME_CHARS = 640;

/** Edge-cache TTL for one post's conversation. Matches engagement's window:
 * replies arrive over hours, and this decouples the AppView's cost from how
 * often the page itself re-renders (~/lib/read-cache's own TTL is 60 s). */
export const COMMENTS_CACHE_TTL_SECONDS = 300;

/** The `$type` a threadViewPost node carries in a union position. */
const THREAD_VIEW_POST = "app.bsky.feed.defs#threadViewPost";

/**
 * Label values that take a reply off this page entirely.
 *
 * #postView carries `labels` (com.atproto.label.defs#label[]) covering both the
 * author's own self-labels and the ones Bluesky's moderation service applied,
 * and we were reading neither. The register is the reason this is a denylist and
 * not a blur-behind-a-click: the conversation section is plain serif text under
 * somebody's essay, with no avatars, no interstitials and nothing to click
 * through — there is no "show anyway" affordance to build here that wouldn't be
 * a worse version of the one Bluesky already has. A reader who wants the
 * unfiltered thread has a link to it.
 *
 * Why these seven:
 * - `!hide` / `!warn` — the two system-level takedown/interstitial verdicts. A
 *   post the network says to hide is not one we re-host.
 * - `porn` / `sexual` / `nudity` / `graphic-media` — the four adult/graphic
 *   values in Bluesky's global label set. They are the ones a reader on a
 *   long-form reading page has consented to exactly nothing about.
 * - `spam` — not a safety call, a quality one: spam under an article is noise
 *   with a link in it.
 *
 * Everything else (self-applied topical labels, third-party labeller opinions
 * a reader may not even subscribe to) passes: this is a floor, not a moderation
 * product, and Bluesky is still the one moderating — as the section says.
 */
const HIDDEN_LABEL_VALUES: ReadonlySet<string> = new Set([
  "!hide",
  "!warn",
  "porn",
  "sexual",
  "nudity",
  "graphic-media",
  "spam",
]);

/**
 * True when a post view carries any label we refuse to render.
 *
 * Reads BOTH the hydrated `post.labels` (where the AppView puts service labels
 * and normally copies self-labels) and the record's own
 * com.atproto.label.defs#selfLabels — belt and braces, because the second is
 * the author's raw claim about their own post and costs one more lookup to
 * respect. A `val` we don't recognise is not a reason to drop anything.
 */
function hasHiddenLabel(post: Record<string, unknown>): boolean {
  const carries = (labels: unknown): boolean =>
    Array.isArray(labels) &&
    labels.some(
      (label) =>
        isRecord(label) &&
        typeof label.val === "string" &&
        HIDDEN_LABEL_VALUES.has(label.val),
    );
  if (carries(post.labels)) return true;
  const record = isRecord(post.record) ? post.record : null;
  const selfLabels = isRecord(record?.labels) ? record.labels : null;
  return carries(selfLabels?.values);
}

/** One renderable reply, already reduced to exactly what the page shows.
 * Everything here is non-optional: a node that couldn't fill all of it in is
 * dropped upstream rather than rendered as a half row. */
export type Reply = {
  /** at:// URI of the reply — React key, and de-duplication. */
  uri: string;
  authorHandle: string;
  /** null when the author has no display name, or it was unusable. */
  authorName: string | null;
  text: string;
  /** ISO timestamp, already validated as parseable. */
  timestamp: string;
  /** The reply on bsky.app. */
  url: string;
  /** This reply is by the writer whose post this is — worth marking, since a
   * writer answering in their own thread reads very differently. */
  byAuthor: boolean;
};

export type PostConversation = {
  /**
   * The replies to render, oldest first.
   *
   * Normally at least one: a conversation with nothing in it isn't returned at
   * all. The single exception is a thread too big to read within
   * MAX_RESPONSE_BYTES, which comes back with no replies and `hasMore: true` —
   * a heading and a way in, rather than a section that vanishes on exactly the
   * posts whose conversation a reader would most want.
   */
  replies: Reply[];
  /** The announcement thread on bsky.app: where a reader goes to join in. */
  threadUrl: string;
  /** True when the thread demonstrably holds more than we render — the cap
   * cut some off, or a rendered reply has replies of its own. Never inferred
   * from replies we dropped (deleted/blocked ones aren't "more to read"). */
  hasMore: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * A reply-position union member reduced to a Reply, or null.
 *
 * Null covers every union member that isn't a live post — #notFoundPost
 * (deleted), #blockedPost (blocked either way), and any member this lexicon
 * grows later — plus live posts we can't honestly render: no attributable
 * author, or no text at all (an image-only reply, which we'd otherwise draw as
 * an empty box). Dropping beats rendering a broken row.
 *
 * Discrimination is by shape as well as `$type`: `notFound`/`blocked` are
 * `const: true` in the lexicon, so they are reliable even if a response ever
 * omits `$type`, and requiring a well-formed `post` means an unrecognised
 * member falls out on its own.
 */
function normalizeReply(node: unknown, authorDid: string): Reply | null {
  if (!isRecord(node)) return null;
  if (node.notFound === true || node.blocked === true) return null;
  if (typeof node.$type === "string" && node.$type !== THREAD_VIEW_POST)
    return null;

  const post = node.post;
  if (!isRecord(post) || typeof post.uri !== "string") return null;
  const parts = parseAtUri(post.uri);
  if (parts?.collection !== "app.bsky.feed.post") return null;
  // Before anything is read out of the record: a labelled reply is dropped
  // rather than rendered, the same discipline the rest of this function
  // applies to replies it can't attribute.
  if (hasHiddenLabel(post)) return null;

  const author = isRecord(post.author) ? post.author : null;
  const handle = typeof author?.handle === "string" ? author.handle : null;
  // Attribution has to be right or absent — this is the same discipline
  // ~/lib/engagement's URI-keyed join enforces. A post view whose author DID
  // disagrees with the DID in its own URI is inconsistent, so we don't guess
  // which one to put a stranger's words next to.
  if (!handle || !isHandle(handle) || author?.did !== parts.did) return null;

  const record = isRecord(post.record) ? post.record : null;
  const text =
    typeof record?.text === "string"
      ? record.text.slice(0, MAX_REPLY_TEXT_CHARS).trim()
      : "";
  if (text === "") return null;

  // `indexedAt` over the record's own `createdAt`: createdAt is whatever the
  // author's client claimed and is routinely wrong (or in the future),
  // whereas indexedAt is when the network actually saw it.
  const timestamp = firstValidDate([post.indexedAt, record?.createdAt]);
  if (!timestamp) return null;

  const name =
    typeof author.displayName === "string" &&
    author.displayName.length <= MAX_DISPLAY_NAME_CHARS
      ? author.displayName.trim()
      : "";

  return {
    uri: post.uri,
    authorHandle: handle,
    authorName: name === "" ? null : name,
    text,
    timestamp,
    // Handles read better than DIDs in a status bar and bsky.app resolves
    // both; `isHandle` already passed, so this is URL-path-safe raw (see
    // bskyPostUrl on why raw and not percent-encoded).
    url: bskyPostUrl(handle, parts.rkey),
    byAuthor: parts.did === authorDid,
  };
}

/**
 * The at-uris the writer hid from their own thread, off the response's
 * top-level `threadgate` (#threadgateView → `record` → `hiddenReplies`).
 *
 * Empty for every thread without a gate, without hidden replies, or with a
 * malformed one — so the caller's drop step is a no-op in the ordinary case and
 * this can only ever remove replies, never add any. The 300-entry lexicon
 * maxLength is enforced rather than trusted: `record` is typed `unknown` in the
 * lexicon, which means the AppView is free to hand us any JSON at all there.
 *
 * The gate's own `post` field is not checked against the thread root. It would
 * be redundant — at-uris are globally unique, so a gate belonging to some other
 * post cannot name a reply that appears in this one.
 */
function hiddenReplyUris(data: unknown): ReadonlySet<string> {
  const gate = isRecord(data) ? data.threadgate : null;
  const record = isRecord(gate) && isRecord(gate.record) ? gate.record : null;
  const listed = record?.hiddenReplies;
  if (!Array.isArray(listed)) return EMPTY_URI_SET;
  const uris = new Set<string>();
  for (const uri of listed.slice(0, MAX_HIDDEN_REPLIES))
    if (typeof uri === "string") uris.add(uri);
  return uris;
}

/** app.bsky.feed.threadgate caps `hiddenReplies` at 300 entries. */
const MAX_HIDDEN_REPLIES = 300;

/** Shared empty set — the answer for the overwhelming majority of threads, so
 * it isn't worth allocating one per call. */
const EMPTY_URI_SET: ReadonlySet<string> = new Set<string>();

/** The first value that parses as a date, as a normalized ISO string. */
function firstValidDate(candidates: unknown[]): string | null {
  for (const value of candidates) {
    if (typeof value !== "string") continue;
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  return null;
}

/**
 * A getPostThread response reduced to the replies a page can render, or null
 * when there is nothing to show.
 *
 * Null is the answer for: a root that isn't a live post (#notFoundPost when
 * the writer deleted the announcement, #blockedPost), a root that isn't the
 * post we asked about, and a thread whose replies all dropped out — including
 * the ordinary case of an announcement nobody has replied to yet. That last
 * one matters: a post with no conversation renders NOTHING, not an empty
 * comment box and not "be the first to reply". Absence is not zero.
 *
 * A thread whose every reply was hidden by the writer or dropped for a label
 * lands in that same null: we are back to having nothing to show, and saying
 * "some replies were hidden" would report the writer's moderation to their
 * readers, which is theirs to disclose and not ours.
 *
 * Exported for tests, and because the parsing is the interesting half of this
 * module — it is worth being able to drive it without a fetch.
 */
export function normalizeThread(
  data: unknown,
  expected: { uri: string; threadUrl: string },
): PostConversation | null {
  const thread = isRecord(data) ? data.thread : null;
  if (!isRecord(thread)) return null;
  if (thread.notFound === true || thread.blocked === true) return null;
  if (typeof thread.$type === "string" && thread.$type !== THREAD_VIEW_POST)
    return null;

  const root = thread.post;
  if (!isRecord(root) || root.uri !== expected.uri) return null;
  const rootParts = parseAtUri(expected.uri);
  if (!rootParts) return null;

  const nodes = Array.isArray(thread.replies) ? thread.replies : [];
  const hidden = hiddenReplyUris(data);
  const seen = new Set<string>();
  const replies: Reply[] = [];
  let nested = false;
  for (const node of nodes) {
    const reply = normalizeReply(node, rootParts.did);
    if (!reply || seen.has(reply.uri)) continue;
    // The writer's own moderation, applied before ours. Deliberately ahead of
    // the `nested` read below: a hidden reply must not contribute "there is
    // more to read over there" either — the writer's answer to it was no.
    if (hidden.has(reply.uri)) continue;
    seen.add(reply.uri);
    replies.push(reply);
    // Read before the cap is applied: "there is more over there" is true of
    // the thread whether or not the nested reply's own parent made the cut.
    if (isRecord(node) && typeof node.post === "object") {
      const count = (node.post as Record<string, unknown>).replyCount;
      if (typeof count === "number" && count > 0) nested = true;
    }
  }
  if (replies.length === 0) return null;

  // Oldest first — a conversation reads forwards, and a fixed order keeps the
  // rendered page (and these tests) deterministic regardless of upstream order.
  replies.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return {
    replies: replies.slice(0, MAX_RENDERED_REPLIES),
    threadUrl: expected.threadUrl,
    hasMore: replies.length > MAX_RENDERED_REPLIES || nested,
  };
}

/**
 * What one getPostThread call can come back as.
 *
 * `over_cap` exists because it is the one failure that means something: the
 * AppView answered, and the thread is simply too big for MAX_RESPONSE_BYTES.
 * That is a busy thread — the case where a reader most wants a way into the
 * conversation — and collapsing it into `failed` deleted the whole section from
 * the page precisely when it mattered most. Everything else stays one
 * indistinguishable `failed`, because everything else genuinely is.
 */
type ThreadFetch =
  | { status: "ok"; body: unknown }
  | { status: "over_cap" }
  | { status: "failed" };

/**
 * One getPostThread call. No throwing: every failure is a value, and the caller
 * turns all but one of them into silence on the page.
 */
async function fetchThread(
  uri: string,
  fetcher: typeof fetch,
): Promise<ThreadFetch> {
  const params = new URLSearchParams({
    uri,
    depth: String(REPLY_DEPTH),
    parentHeight: "0",
  });
  // Fixed host, never derived from input — SSRF guard by construction, same
  // as ~/lib/engagement's single AppView constant.
  const url = `https://${APPVIEW_HOST}/xrpc/app.bsky.feed.getPostThread?${params}`;
  try {
    const res = await fetcher(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { status: "failed" };
    const bytes = await readBodyCapped(res, MAX_RESPONSE_BYTES);
    // readBodyCapped returns null for EXACTLY one reason — the cap was crossed
    // (declared content-length over it, or the stream ran past it). A body that
    // fails to arrive at all throws instead, and lands in the catch below. That
    // is what makes this branch a reliable "too big" signal rather than a guess.
    if (!bytes) return { status: "over_cap" };
    return { status: "ok", body: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { status: "failed" };
  }
}

/** Synthetic, cacheable-key URL for one post's conversation. Public data, so
 * the URI goes in directly; still a synthetic internal host, never routable.
 * Cookie-independent by construction — nothing about the reader is in the key,
 * which is what lets the reading surfaces share one cached copy. */
function conversationCacheUrl(uri: string): string {
  return `https://goldroad-comments.internal/v1/${encodeURIComponent(uri)}`;
}

/** Cache read — a miss, a malformed entry, and no cache at all are one
 * answer: null. Re-normalized on the way out so a stale entry written by an
 * older shape can never reach the renderer. */
async function readCached(
  cache: Cache,
  uri: string,
): Promise<PostConversation | null> {
  const hit = await cache
    .match(conversationCacheUrl(uri))
    .catch(() => undefined);
  if (!hit) return null;
  const cached = (await hit.json().catch(() => null)) as unknown;
  if (!isRecord(cached) || !Array.isArray(cached.replies)) return null;
  if (cached.replies.length === 0) return null;
  return cached as PostConversation;
}

/** Cache write. Best-effort — a failed put costs the next reader one upstream
 * call and nothing else. */
async function writeCached(
  cache: Cache,
  uri: string,
  conversation: PostConversation,
): Promise<void> {
  const response = new Response(JSON.stringify(conversation), {
    headers: {
      "content-type": "application/json",
      "cache-control": `public, s-maxage=${COMMENTS_CACHE_TTL_SECONDS}`,
    },
  });
  await cache.put(conversationCacheUrl(uri), response).catch(() => {});
}

/**
 * The document-page entry point: given a document's raw `bskyPostRef`, the
 * replies to its announcement plus the thread URL — or null, which the page
 * renders as nothing at all.
 *
 * Null means, indistinguishably: never announced, malformed ref, a ref pointing
 * outside `expectedDid`'s repo, the AppView was down or slow or hostile, the
 * announcement was deleted, or nobody has replied yet. The caller does not need
 * to tell those apart, because on a reading surface they all look the same: the
 * writer's words, undisturbed.
 *
 * The one non-null-but-empty answer is a thread over the byte cap — see
 * PostConversation.replies.
 */
export async function getPostConversation(
  ref: { uri?: unknown } | undefined,
  expectedDid: string,
  options: { fetcher?: typeof fetch; cache?: Cache } = {},
): Promise<PostConversation | null> {
  const announced = announcedPostUri(ref, expectedDid);
  if (!announced) return null;
  const threadUrl = bskyPostUrl(announced.did, announced.rkey);

  const cache = options.cache ?? defaultCache();
  if (cache) {
    const cached = await readCached(cache, announced.uri);
    if (cached) return { ...cached, threadUrl };
  }

  const fetched = await fetchThread(announced.uri, options.fetcher ?? fetch);
  if (fetched.status === "failed") return null;
  // A thread we couldn't fit in memory is still a thread that exists, and we
  // already know its URL. Heading plus "read the rest and reply on Bluesky",
  // no rows — not cached, because the cache read path treats a reply-less entry
  // as malformed, and re-deriving this costs one call the page never waits on.
  if (fetched.status === "over_cap")
    return { replies: [], threadUrl, hasMore: true };

  const conversation = normalizeThread(fetched.body, {
    uri: announced.uri,
    threadUrl,
  });
  if (!conversation) return null;

  if (cache) await writeCached(cache, announced.uri, conversation);
  return conversation;
}
