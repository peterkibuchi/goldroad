/**
 * Thread import — turning a writer's OWN Bluesky threads into Goldroad drafts.
 *
 * The beachhead this serves is the writer whose long-form corpus is threads
 * rather than an RSS archive. `~/lib/import` moves a stranger's publication
 * across; this moves the writer's own posts, which is a different act with a
 * different honest stance (see `source_kind` in ~/db/schema): the canonical
 * stays here, because a thread was never a canonical web page.
 *
 * Two reads, both against the PUBLIC AppView, unauthenticated — the same door
 * ~/lib/engagement and ~/lib/comments already knock on, with the same
 * discipline: a FIXED host (never derived from input, so SSRF is impossible by
 * construction), a wall-clock timeout, a streaming byte cap, and null for every
 * way a call can go wrong.
 *
 *  1. DISCOVERY (`app.bsky.feed.getAuthorFeed`, filter=posts_with_replies):
 *     a bounded page-walk of the writer's own feed, reduced to the threads in
 *     it. A thread is a root the writer wrote with at least one of their own
 *     replies chained to it.
 *  2. ASSEMBLY (`app.bsky.feed.getPostThread`): one thread's spine, converted
 *     to markdown.
 *
 * Response shapes verified 2026-08-17 against the live AppView and the
 * published lexicons (app.bsky.feed.getAuthorFeed / getPostThread /
 * feed/defs.json / richtext/facet.json / embed/*.json on
 * bluesky-social/atproto@main): getAuthorFeed answers `{ feed: feedViewPost[],
 * cursor? }` where a feedViewPost is `{ post: #postView, reply?, reason? }`
 * and a repost carries `reason.$type === "…#reasonRepost"`; getPostThread
 * answers `{ thread }` as the #threadViewPost | #notFoundPost | #blockedPost
 * union, threadViewPost carrying `post` and a `replies` array of that same
 * union. Every field is still read defensively — this is network data.
 *
 * Pure module — no `cloudflare:workers` import, fetch injectable — so the whole
 * conversion unit-tests without a worker or a network.
 */
import { isDid, isHandle, parseAtUri } from "~/lib/atproto";
import { readBodyCapped } from "~/lib/blob";
import { APPVIEW_HOST, bskyPostUrl, bskyProfileUrl } from "~/lib/engagement";

/** Feed items per discovery page. The lexicon allows 100; 50 keeps one
 * response near the 270 KB a real 50-item page measured rather than double
 * that, which matters on a 10 ms CPU budget. */
export const THREAD_FEED_PAGE_LIMIT = 50;

/** Discovery pages walked per run — 150 feed items, the same order of window
 * ~/lib/atproto's MAX_ARCHIVE_PAGES allows a repo read. A feed is a window,
 * not the archive, and the picker says so. */
export const MAX_THREAD_DISCOVERY_PAGES = 3;

/** Threads the picker lists per run. */
export const MAX_THREADS_LISTED = 50;

/** Posts one assembled thread carries. Past this the spine is cut and the
 * result says so — a thread this long is a book, not a post. */
export const MAX_THREAD_POSTS = 50;

/** `depth` asked of getPostThread. One request covers a whole spine up to the
 * post cap: the AppView bounds replies per level, so a real thread's depth-50
 * response measured 13 KB (verified 2026-08-17), nowhere near the byte cap. */
export const THREAD_DEPTH = MAX_THREAD_POSTS;

/** Wall-clock bound per AppView call. Matches ~/lib/engagement's leash: this
 * runs inside a writer's own request, not a reader's page render. */
export const THREAD_FETCH_TIMEOUT_MS = 5_000;

/** Streaming cap on one AppView response — never trusted from Content-Length.
 * Generous over the ~270 KB a full discovery page measures, and far over the
 * ~13 KB a thread response does. */
export const MAX_THREAD_RESPONSE_BYTES = 768 * 1024;

/** app.bsky.feed.post caps `text` at 3000 characters (300 for `alt`s sibling
 * fields, but alt itself is generous) — a record claiming more is malformed or
 * hostile, so it is clamped rather than trusted. */
const MAX_POST_TEXT_CHARS = 3_000;

/** Alt text carried per image. Bluesky's own limit is far below this; the cap
 * exists so a hostile record can't hand the body a novel. */
const MAX_ALT_CHARS = 1_000;

/** Images one post can carry (app.bsky.embed.images caps at 4). */
const MAX_IMAGES_PER_POST = 4;

/** Discovery runs and thread assemblies a writer can spend per hour, counted
 * in the `import_fetches` ledger under kind `thread`. Deliberately far above
 * the feed importer's 6: one row here is one bounded AppView read, and
 * bringing twenty threads across is an ordinary afternoon, not abuse. */
export const MAX_THREAD_FETCHES_PER_HOUR = 60;

/** How long a discovery result is held at the edge. Short: the writer may post
 * a new thread and come straight back, and a stale list would hide it. Long
 * enough that paging back and forth in the picker costs nothing. */
export const THREAD_DISCOVERY_CACHE_TTL_SECONDS = 60;

/** Title length this module clamps to. Comfortably under ~/lib/publish's
 * MAX_TITLE_LENGTH (1000) — a title that long is a paragraph. */
const MAX_TITLE_CHARS = 120;

/** The `$type` a threadViewPost node carries in a union position. */
const THREAD_VIEW_POST = "app.bsky.feed.defs#threadViewPost";

/** Bluesky's own post collection — the only one either read touches. */
const POST_COLLECTION = "app.bsky.feed.post";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * One of the writer's own posts, reduced to what discovery and assembly both
 * need. Everything here is validated: the URI parsed, the author confirmed,
 * the date parseable.
 */
export type ThreadPost = {
  /** at:// URI — the identity, and the dedupe key when it's a root. */
  uri: string;
  /** rkey, for building the bsky.app link. */
  rkey: string;
  text: string;
  /** `app.bsky.richtext.facet[]` as the record carried it — untrusted. */
  facets: unknown[];
  /** The record's own embed view (images / quote / external / video). */
  embed: unknown;
  /** ISO timestamp. */
  createdAt: string;
  /** at:// URI of the post this replies to, or null for a thread head. */
  parentUri: string | null;
};

/**
 * A #postView reduced to a ThreadPost, or null.
 *
 * Null covers: a view we can't parse, a post that isn't in the post
 * collection, a post by SOMEBODY ELSE (which is how a repost and a reply to a
 * stranger both fall out — a repost's postView carries the original author),
 * a post whose author DID disagrees with the DID in its own URI, and a post
 * with no parseable date. Attribution has to be right or absent; this is the
 * same discipline ~/lib/comments' normalizeReply enforces.
 *
 * `createdAt` is read from the record and NOT `indexedAt` — the opposite of
 * the comments module's choice, on purpose. There, a timestamp is decoration
 * next to a stranger's words and a client-supplied one is routinely wrong.
 * Here it becomes the document's own `publishedAt` and its backdated TID, so
 * what matters is when the WRITER says they wrote it. `indexedAt` is the
 * fallback, and ~/lib/import's clampOriginalDate refuses a future date at
 * publish time regardless.
 */
export function normalizePost(
  view: unknown,
  author: string,
): ThreadPost | null {
  if (!isRecord(view)) return null;
  const uri = str(view.uri);
  if (!uri) return null;
  const parts = parseAtUri(uri);
  if (!parts || parts.collection !== POST_COLLECTION) return null;
  if (parts.did !== author) return null;
  const viewAuthor = isRecord(view.author) ? view.author : null;
  if (str(viewAuthor?.did) !== parts.did) return null;

  const record = isRecord(view.record) ? view.record : null;
  if (!record) return null;
  const createdAt = firstValidDate([record.createdAt, view.indexedAt]);
  if (!createdAt) return null;

  const reply = isRecord(record.reply) ? record.reply : null;
  const parentRaw = isRecord(reply?.parent) ? str(reply.parent.uri) : null;
  // A parent we can't parse is treated as "not a self-reply" rather than
  // guessed at: it can only cost one thread its detection, never mis-chain.
  const parentParts = parentRaw ? parseAtUri(parentRaw) : null;

  return {
    uri,
    rkey: parts.rkey,
    text:
      typeof record.text === "string"
        ? record.text.slice(0, MAX_POST_TEXT_CHARS)
        : "",
    facets: Array.isArray(record.facets) ? record.facets : [],
    embed: view.embed,
    createdAt,
    parentUri:
      parentParts && parentParts.collection === POST_COLLECTION
        ? parentRaw
        : null,
  };
}

/** The first value that parses as a date, as a normalized ISO string. */
function firstValidDate(candidates: unknown[]): string | null {
  for (const value of candidates) {
    if (typeof value !== "string") continue;
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  return null;
}

/** One thread as the picker lists it. */
export type ThreadSummary = {
  /** The root's at:// URI — the ledger's dedupe identity. */
  rootUri: string;
  /** SHA-256 hex of rootUri, filled in by the route (the ledger key). */
  guidHash: string;
  /** The title a draft would get — the root's first line, clamped. */
  title: string;
  /** Posts found on the writer's own spine, root included (>= 2). */
  postCount: number;
  /** The root's createdAt (ISO) — what the draft would be backdated to. */
  createdAt: string;
  /** The root post on bsky.app. */
  url: string;
  /** Ledger says this thread is already a draft or a published post. */
  alreadyImported: boolean;
};

/**
 * Feed pages → the threads in them.
 *
 * A thread is a ROOT THE WRITER WROTE (a post of theirs with no reply ref)
 * with at least one of their own replies chained to it. Everything else in the
 * feed falls away: singles (out of scope for v1 — one post is a post, not a
 * piece), reposts, and replies to other people, including the case where the
 * writer's own long chain hangs off a stranger's post. That last exclusion is
 * a real choice, and it is the conservative one: a chain rooted in someone
 * else's conversation reads as participation, and importing it as a standalone
 * document would strip the thing it was answering.
 *
 * Branching threads take the EARLIEST self-reply at each step. Writers do
 * revise mid-thread and end up with two children on one post; the first one is
 * the spine they wrote, and picking by date rather than by feed order makes the
 * choice independent of how the AppView happened to order the page.
 *
 * The spine is only as long as the window shows. Discovery's count is what was
 * found here; assembly re-reads the thread and is authoritative — which is why
 * `postCount` is presented as a count of posts and never as a promise.
 */
export function discoverThreads(
  pages: unknown[],
  author: string,
): { threads: Omit<ThreadSummary, "guidHash" | "alreadyImported">[] } {
  const own = new Map<string, ThreadPost>();
  for (const page of pages) {
    const feed = isRecord(page) && Array.isArray(page.feed) ? page.feed : [];
    for (const item of feed) {
      if (!isRecord(item)) continue;
      // A repost is somebody else's post in the writer's feed. normalizePost
      // already drops it on the author check; this is the explicit statement
      // of intent, and it also drops a self-repost, which is not a thread.
      if (isRecord(item.reason)) continue;
      const post = normalizePost(item.post, author);
      if (post && !own.has(post.uri)) own.set(post.uri, post);
    }
  }

  // Self-replies only: a child whose parent is one of the posts above.
  const children = new Map<string, ThreadPost[]>();
  for (const post of own.values()) {
    if (!post.parentUri || !own.has(post.parentUri)) continue;
    const siblings = children.get(post.parentUri);
    if (siblings) siblings.push(post);
    else children.set(post.parentUri, [post]);
  }

  const threads: Omit<ThreadSummary, "guidHash" | "alreadyImported">[] = [];
  for (const root of own.values()) {
    if (root.parentUri !== null) continue; // not a thread head
    const spine = walkSpine(root, (uri) => children.get(uri) ?? []);
    if (spine.length < 2) continue; // a single post is not a thread
    threads.push({
      rootUri: root.uri,
      title: threadTitle(root.text),
      postCount: spine.length,
      createdAt: root.createdAt,
      url: bskyPostUrl(spineAuthor(root), root.rkey),
    });
  }

  // Newest first — the order every picker in the app presents.
  threads.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { threads: threads.slice(0, MAX_THREADS_LISTED) };
}

/** The DID out of a post's own URI — always present (parseAtUri validated it
 * before the post was built), and used raw in the bsky.app path exactly as
 * ~/lib/engagement's bskyPostUrl documents. */
function spineAuthor(post: ThreadPost): string {
  return parseAtUri(post.uri)?.did ?? "";
}

/**
 * Follow one post's own reply spine, earliest child first, bounded by
 * MAX_THREAD_POSTS. Cycle-safe: a `seen` set means a malformed graph (a post
 * claiming its own descendant as a parent) terminates instead of spinning.
 */
function walkSpine(
  root: ThreadPost,
  childrenOf: (uri: string) => ThreadPost[],
): ThreadPost[] {
  const spine: ThreadPost[] = [root];
  const seen = new Set([root.uri]);
  for (let i = 0; i < MAX_THREAD_POSTS - 1; i++) {
    const current = spine[spine.length - 1];
    const next = childrenOf(current.uri)
      .filter((child) => !seen.has(child.uri))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!next) break;
    seen.add(next.uri);
    spine.push(next);
  }
  return spine;
}

/**
 * A thread's title: the root's first non-empty line, clamped.
 *
 * Deliberately NOT clever. Thread openers carry "🧵", "1/12", "a thread:" and
 * every other convention, and stripping them means guessing which of the
 * writer's own words were scaffolding — a guess that is wrong in public, on
 * their post. The writer retitles in the editor before publishing, which is
 * one edit against a class of silent mangling.
 */
export function threadTitle(text: string): string {
  const firstLine = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "");
  if (!firstLine) return "Untitled thread";
  // Titles are a display field, not prose: they never carry markdown, so the
  // text goes in as written rather than escaped.
  return firstLine.length > MAX_TITLE_CHARS
    ? `${firstLine.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…`
    : firstLine;
}

/**
 * Markdown-significant characters in text the writer wrote as PLAIN text.
 *
 * A thread post saying `*not emphasis*` renders literally on Bluesky, and it
 * has to keep rendering literally here — otherwise import silently restyles
 * the writer's words. The escapes survive exactly as far as they need to: the
 * browser parses this markdown into editor blocks, which unescapes them, so
 * what the writer sees in the editor (and what publishes) is the literal text.
 */
export function escapeMarkdownText(text: string): string {
  return (
    text
      .replace(/([\\`*_[\]<>|])/g, "\\$1")
      // Line-leading structure: #, >, -, +, = would become a heading, quote,
      // list or setext rule. `1.` too, hence the digit case.
      .replace(/^([#>\-+=])/gm, "\\$1")
      .replace(/^(\d+)\./gm, "$1\\.")
  );
}

/**
 * A facet feature reduced to what it renders as, or null to leave the span as
 * plain text.
 *
 * Links are https-only, matching ~/lib/import's safeLink rule: an `http://`
 * link from a years-old post is left as visible text rather than upgraded to a
 * scheme it never had, and a `javascript:`/`data:` URI never reaches the
 * renderer at all. (The reader's react-markdown would refuse those anyway —
 * this is the layer that refuses them first.)
 *
 * Mentions link to the mentioned account's DID rather than to the handle in
 * the text: the DID is what the facet actually asserts, and it keeps resolving
 * after the account renames. The visible label stays the @handle the writer
 * typed.
 */
function facetHref(feature: unknown): string | null {
  if (!isRecord(feature)) return null;
  const type = str(feature.$type) ?? "";
  if (type.endsWith("#link")) {
    const uri = str(feature.uri);
    return uri?.startsWith("https://") ? uri : null;
  }
  if (type.endsWith("#mention")) {
    const did = str(feature.did);
    return did && isDid(did) ? bskyProfileUrl(did) : null;
  }
  // #tag and anything this lexicon grows later: the text stands on its own. A
  // hashtag linking into Bluesky search is not what a writer means by putting
  // it in an essay.
  return null;
}

/** One usable facet: a byte range and the href it links to. */
type ResolvedFacet = { start: number; end: number; href: string };

/**
 * Facets → sorted, non-overlapping byte ranges.
 *
 * `index` is a BYTE range into the post's UTF-8 text, not a character range —
 * getting that wrong shifts every link in any post containing an emoji or an
 * accent, which is most of them. So the caller works in bytes and this
 * validates in bytes: a range outside the text, inverted, or overlapping one
 * already accepted is dropped rather than clamped, because a half-applied
 * range would move a link onto words it doesn't belong to.
 */
export function resolveFacets(
  facets: unknown[],
  byteLength: number,
): ResolvedFacet[] {
  const resolved: ResolvedFacet[] = [];
  for (const facet of facets) {
    if (!isRecord(facet)) continue;
    const index = isRecord(facet.index) ? facet.index : null;
    const start = index?.byteStart;
    const end = index?.byteEnd;
    if (typeof start !== "number" || typeof end !== "number") continue;
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
    if (start < 0 || end > byteLength || start >= end) continue;
    const features = Array.isArray(facet.features) ? facet.features : [];
    const href = features.map(facetHref).find((candidate) => candidate != null);
    if (!href) continue;
    resolved.push({ start, end, href });
  }
  resolved.sort((a, b) => a.start - b.start);
  const out: ResolvedFacet[] = [];
  for (const facet of resolved) {
    const previous = out[out.length - 1];
    if (previous && facet.start < previous.end) continue; // overlap — drop
    out.push(facet);
  }
  return out;
}

/**
 * One post's text as markdown, with its faceted links applied.
 *
 * Line handling: every newline starts a new paragraph. Thread text is written
 * in short lines and a paragraph per line reads correctly as long-form, but the
 * real reason is that it round-trips: paragraphs survive markdown → editor
 * blocks → markdown intact, where a hard line break inside a paragraph is
 * exactly the kind of thing a lossy export drops. No words are ever lost either
 * way; this way no structure is either.
 */
export function postTextMarkdown(post: ThreadPost): string[] {
  const text = post.text;
  if (text.trim() === "") return [];
  const bytes = new TextEncoder().encode(text);
  const facets = resolveFacets(post.facets, bytes.length);
  const decoder = new TextDecoder();

  // Rebuilt span by span in byte space, so a facet's range lands on exactly
  // the characters it names however many bytes those characters take.
  let out = "";
  let cursor = 0;
  for (const facet of facets) {
    out += escapeMarkdownText(decoder.decode(bytes.slice(cursor, facet.start)));
    const label = escapeMarkdownText(
      decoder.decode(bytes.slice(facet.start, facet.end)),
    );
    out += `[${label}](${facet.href})`;
    cursor = facet.end;
  }
  out += escapeMarkdownText(decoder.decode(bytes.slice(cursor)));

  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** What one post's embed contributes to the body, plus what it couldn't. */
type EmbedResult = {
  /** Markdown blocks (image lines, quote lines, link-card lines). */
  blocks: string[];
  /** This post carried a video, which cannot come across. */
  video: boolean;
};

/**
 * One post's embed as markdown.
 *
 * IMAGES rehost for free. The line is `![alt](fullsize-cdn-url)`, which is
 * exactly the shape ~/lib/import's publish-time `rehostBodyImages` already
 * looks for: when the writer publishes the draft, that copies every one into
 * their own repo under the feed importer's SSRF regime and rewrites only the
 * URL inside the match — so the alt text Bluesky carried survives into the
 * record. Nothing about images is reimplemented here, and the alt is
 * first-class rather than an afterthought: it is the writer's own description
 * of their own picture and dropping it would be a regression in the
 * accessibility of their archive.
 *
 * A QUOTE of another post becomes a LINK, never inlined content. Someone
 * else's words do not go into the writer's record — that would be republishing
 * a stranger under the writer's name, on the writer's canonical URL, in a
 * record only the writer can delete. The link is what the writer actually did:
 * they pointed at it.
 *
 * A LINK CARD contributes its title as a link, unless the same URL is already
 * a facet link in the text — Bluesky often builds the card FROM a URL in the
 * post, and emitting both would read as a stutter.
 *
 * A VIDEO cannot come across at all (no video anywhere in our lexicon or
 * storage), so it is reported rather than silently dropped — the same call the
 * feed importer's "Embed won't come across" badge makes.
 */
export function embedMarkdown(post: ThreadPost): EmbedResult {
  const blocks: string[] = [];
  let video = false;
  // recordWithMedia carries BOTH a quote and a media embed; unwrap it into the
  // two halves and treat each exactly as it would be treated on its own. The
  // record half is itself a #recordView wrapper, which is the same shape the
  // standalone quote case already handles.
  const embed = post.embed;
  const halves: unknown[] =
    isRecord(embed) && isRecord(embed.record) && isRecord(embed.media)
      ? [embed.media, embed.record]
      : [embed];

  const linkedHrefs = new Set(
    resolveFacets(post.facets, new TextEncoder().encode(post.text).length).map(
      (facet) => facet.href,
    ),
  );

  for (const half of halves) {
    if (!isRecord(half)) continue;
    // Images: `images` is the discriminator the view shape actually carries,
    // and checking the shape rather than only `$type` is what keeps a
    // recordWithMedia half (whose $type names the wrapper) working.
    if (Array.isArray(half.images)) {
      for (const image of half.images.slice(0, MAX_IMAGES_PER_POST)) {
        if (!isRecord(image)) continue;
        const url = str(image.fullsize) ?? str(image.thumb);
        if (!url?.startsWith("https://")) continue;
        const alt =
          typeof image.alt === "string"
            ? escapeMarkdownText(image.alt.slice(0, MAX_ALT_CHARS).trim())
            : "";
        blocks.push(`![${alt}](${url})`);
      }
      continue;
    }
    // A quoted record: `record` holding a post view with its own author.
    const quoted = isRecord(half.record) ? half.record : null;
    if (quoted) {
      const line = quoteLine(quoted);
      if (line) blocks.push(line);
      continue;
    }
    // A link card.
    const external = isRecord(half.external) ? half.external : null;
    if (external) {
      const uri = str(external.uri);
      if (uri?.startsWith("https://") && !linkedHrefs.has(uri)) {
        const label = escapeMarkdownText(
          (str(external.title) ?? uri).slice(0, MAX_TITLE_CHARS).trim(),
        );
        blocks.push(`[${label || uri}](${uri})`);
      }
      continue;
    }
    if (str(half.$type)?.startsWith("app.bsky.embed.video")) video = true;
  }
  return { blocks, video };
}

/**
 * "Quoting @someone" as one markdown line, or null when the quoted post can't
 * be attributed (deleted, blocked, or a view we can't parse). Unattributable
 * is silence: a line saying the writer quoted *something* helps nobody.
 */
function quoteLine(quoted: Record<string, unknown>): string | null {
  const uri = str(quoted.uri);
  const parts = uri ? parseAtUri(uri) : null;
  if (!parts || parts.collection !== POST_COLLECTION) return null;
  const author = isRecord(quoted.author) ? quoted.author : null;
  const handle = str(author?.handle);
  // Same rule as ~/lib/comments: the author DID must agree with the DID in the
  // post's own URI, or we don't put a name next to a link.
  if (!handle || !isHandle(handle) || str(author?.did) !== parts.did)
    return null;
  return `Quoting [@${handle}](${bskyPostUrl(handle, parts.rkey)})`;
}

/** An assembled thread, ready to become a draft. */
export type AssembledThread = {
  rootUri: string;
  title: string;
  /** The body as GitHub-Flavored CommonMark. */
  markdown: string;
  /** Posts actually used, root included. */
  postCount: number;
  /** The root's createdAt (ISO) — the draft's backdated original date. */
  createdAt: string;
  /** The root post on bsky.app — the provenance link. */
  sourceUrl: string;
  /** The spine was longer than MAX_THREAD_POSTS and was cut. */
  truncated: boolean;
  /** Some post in the thread carried a video, which cannot come across. */
  droppedVideo: boolean;
};

/**
 * A getPostThread response → an assembled thread, or null when there is
 * nothing honest to assemble.
 *
 * Null is the answer for: a root that isn't a live post (#notFoundPost after
 * the writer deleted it, #blockedPost), a root that isn't the post we asked
 * about, a root by somebody else (the DID gate — this endpoint only ever
 * assembles the SESSION's own threads), a thread with no self-reply (the same
 * v1 rule discovery applies, restated here so the API can't be talked past
 * its own filter), and a thread whose posts all turn out to be empty.
 *
 * The spine follows ONLY the author's own replies. Every other reply in the
 * response — strangers agreeing, strangers arguing, the writer's own reply to
 * a stranger further down — is skipped, because the piece being imported is the
 * writer's, and nobody else consented to being in it.
 */
export function assembleThread(
  data: unknown,
  expected: { rootUri: string; author: string },
): AssembledThread | null {
  const thread = isRecord(data) ? data.thread : null;
  if (!isRecord(thread)) return null;
  if (thread.notFound === true || thread.blocked === true) return null;
  const type = str(thread.$type);
  if (type && type !== THREAD_VIEW_POST) return null;

  const root = normalizePost(thread.post, expected.author);
  if (!root || root.uri !== expected.rootUri) return null;

  const spine: ThreadPost[] = [root];
  const nodes: Record<string, unknown>[] = [thread];
  const seen = new Set([root.uri]);
  let truncated = false;
  while (spine.length < MAX_THREAD_POSTS) {
    const node = nodes[nodes.length - 1];
    const next = nextSelfReply(node, expected.author, seen);
    if (!next) break;
    seen.add(next.post.uri);
    spine.push(next.post);
    nodes.push(next.node);
  }
  // Anything left on the spine past the cap is a cut, said out loud.
  if (spine.length >= MAX_THREAD_POSTS) {
    truncated =
      nextSelfReply(nodes[nodes.length - 1], expected.author, seen) !== null;
  }
  if (spine.length < 2) return null;

  const blocks: string[] = [];
  let droppedVideo = false;
  for (const post of spine) {
    blocks.push(...postTextMarkdown(post));
    const embed = embedMarkdown(post);
    blocks.push(...embed.blocks);
    droppedVideo = droppedVideo || embed.video;
  }
  if (blocks.length === 0) return null;

  return {
    rootUri: root.uri,
    title: threadTitle(root.text),
    // Blank-line separated: one paragraph (or image, or link line) per block.
    // No "1/" markers and no rules between posts — the point of the import is
    // that it reads as one piece, which is what it was.
    markdown: blocks.join("\n\n"),
    postCount: spine.length,
    createdAt: root.createdAt,
    sourceUrl: bskyPostUrl(spineAuthor(root), root.rkey),
    truncated,
    droppedVideo,
  };
}

/** The earliest not-yet-used self-reply under a threadViewPost node. */
function nextSelfReply(
  node: Record<string, unknown>,
  author: string,
  seen: Set<string>,
): { post: ThreadPost; node: Record<string, unknown> } | null {
  const replies = Array.isArray(node.replies) ? node.replies : [];
  const candidates: { post: ThreadPost; node: Record<string, unknown> }[] = [];
  for (const reply of replies) {
    if (!isRecord(reply)) continue;
    if (reply.notFound === true || reply.blocked === true) continue;
    const replyType = str(reply.$type);
    if (replyType && replyType !== THREAD_VIEW_POST) continue;
    const post = normalizePost(reply.post, author);
    if (!post || seen.has(post.uri)) continue;
    candidates.push({ post, node: reply });
  }
  candidates.sort((a, b) => a.post.createdAt.localeCompare(b.post.createdAt));
  return candidates[0] ?? null;
}

/**
 * One AppView GET. Returns the parsed body, or null when the call failed in any
 * way at all (non-2xx, network error, timeout, oversized or unparseable body).
 * The host is the FIXED constant — no code path here builds it from input.
 */
async function appViewGet(
  method: string,
  params: URLSearchParams,
  fetcher: typeof fetch,
): Promise<unknown | null> {
  try {
    const res = await fetcher(
      `https://${APPVIEW_HOST}/xrpc/${method}?${params}`,
      { signal: AbortSignal.timeout(THREAD_FETCH_TIMEOUT_MS) },
    );
    if (!res.ok) return null;
    const bytes = await readBodyCapped(res, MAX_THREAD_RESPONSE_BYTES);
    if (!bytes) return null;
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/** One page of the writer's own feed, replies included. */
export async function fetchAuthorFeedPage(
  did: string,
  cursor: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<{ page: unknown; cursor: string | null } | null> {
  const params = new URLSearchParams({
    actor: did,
    filter: "posts_with_replies",
    limit: String(THREAD_FEED_PAGE_LIMIT),
  });
  if (cursor) params.set("cursor", cursor);
  const body = await appViewGet("app.bsky.feed.getAuthorFeed", params, fetcher);
  if (body === null) return null;
  const next = isRecord(body) ? str(body.cursor) : null;
  // A cursor is an opaque upstream string that goes straight back out in the
  // next request's query — bound it, same rule as ~/lib/atproto's isValidCursor.
  return { page: body, cursor: next && next.length <= 512 ? next : null };
}

/** One thread, depth-bounded. */
export async function fetchThread(
  rootUri: string,
  fetcher: typeof fetch = fetch,
): Promise<unknown | null> {
  return appViewGet(
    "app.bsky.feed.getPostThread",
    new URLSearchParams({
      uri: rootUri,
      depth: String(THREAD_DEPTH),
      parentHeight: "0",
    }),
    fetcher,
  );
}

/**
 * The writer's threads, walked across up to MAX_THREAD_DISCOVERY_PAGES pages.
 * Sequential by necessity (each page's cursor comes from the last response) and
 * bounded by construction. A page that fails ends the walk with what came
 * before it rather than failing the run: a partial list is useful, and the
 * picker says a feed is a window either way.
 *
 * `truncated` is true when the AppView still had pages left — the honest "there
 * may be older threads than these" signal the surface shows.
 */
export async function discoverAuthorThreads(
  did: string,
  fetcher: typeof fetch = fetch,
): Promise<{
  threads: Omit<ThreadSummary, "guidHash" | "alreadyImported">[];
  truncated: boolean;
  /** Upstream refused/flaked on the FIRST page — nothing was read at all. */
  unavailable: boolean;
} | null> {
  const pages: unknown[] = [];
  let cursor: string | undefined;
  let truncated = false;
  for (let i = 0; i < MAX_THREAD_DISCOVERY_PAGES; i++) {
    const result = await fetchAuthorFeedPage(did, cursor, fetcher);
    if (!result) {
      if (i === 0) return { threads: [], truncated: false, unavailable: true };
      break;
    }
    pages.push(result.page);
    if (!result.cursor) break;
    cursor = result.cursor;
    truncated = i === MAX_THREAD_DISCOVERY_PAGES - 1;
  }
  return {
    ...discoverThreads(pages, did),
    truncated,
    unavailable: false,
  };
}
