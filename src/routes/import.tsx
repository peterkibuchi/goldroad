/**
 * /import — one-time import (feed OR an uploaded export file → drafts).
 * Writer surface in the dashboard chrome family. Two sources feed ONE
 * pipeline:
 *
 *  1. Source: paste a feed address (the server fetches + parses it, capped at
 *     the feed's recent window), or upload ONE export file — a Substack or
 *     Medium export zip, a Ghost JSON export, or a WordPress WXR XML export.
 *     Every file format is detected (~/lib/import-formats) and parsed
 *     ENTIRELY in the browser (~/lib/import-zip, ~/lib/import-medium,
 *     ~/lib/import-ghost, ~/lib/import-wxr — the file never leaves the
 *     machine), and carries the writer's whole archive, not just recent
 *     posts.
 *  2. Pick: the found items — full posts checked by default (capped at the
 *     drafts headroom), previews and already-imported items honestly flagged
 *     and unchecked. Already-imported flags for the file path come from
 *     /api/import/status (hashes only cross the wire). Non-post entries each
 *     format's export carries (WordPress pages/attachments, Ghost pages,
 *     Medium responses/comments) are filtered before the picker and reported
 *     honestly as a skip count, never silently imported as posts.
 *  3. Import: the BROWSER converts each item's HTML to editor blocks
 *     (BlockNote's parser structurally drops script/iframe/unknown nodes —
 *     conversion is the sanitizer) and saves it as a private draft, one
 *     progress row per item; partial failure never aborts the run.
 *  4. Done: drafts saved, nothing published, the source unchanged — publish
 *     each piece deliberately from the dashboard.
 *
 * Everything lands as PRIVATE drafts: an atproto record is public the moment
 * it exists, so "import" and "publish" stay separate acts by design.
 */
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { drizzle } from "drizzle-orm/d1";
import { useState } from "react";

import { formatDate } from "~/components/document-article";
import { Notice } from "~/components/notice";
import { AppShell } from "~/components/site-chrome";
import { resolveDidToHandle } from "~/lib/atproto";
import {
  detectFileKind,
  detectZipVariant,
  MAX_EXPORT_TEXT_BYTES,
  MAX_EXPORT_ZIP_BYTES,
} from "~/lib/import-formats";
import { readLiveSessionDid } from "~/lib/live-session";
import { capture } from "~/lib/posthog";
import { env } from "cloudflare:workers";

const getImportViewer = createServerFn({ method: "GET" }).handler(async () => {
  const did = await readLiveSessionDid(
    getRequest(),
    env.COOKIE_SECRET,
    drizzle(env.DB),
  );
  if (!did) return null;
  const handle = await resolveDidToHandle(did).catch(() => null);
  return { ident: handle ?? did };
});

export const Route = createFileRoute("/import")({
  loader: async () => {
    const viewer = await getImportViewer();
    // Unauthed → /write, which renders the sign-in form (same as /dashboard),
    // carrying this page as the destination to come back to.
    if (!viewer)
      throw redirect({ to: "/write", search: { returnTo: "/import" } });
    return viewer;
  },
  head: () => ({
    meta: [
      { title: "Import your writing — Goldroad" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ImportPage,
});

type ImportItem = {
  guid: string;
  guidHash: string;
  link: string | null;
  title: string;
  publishedAt: string | null;
  contentHtml: string;
  preview: boolean;
  alreadyImported: boolean;
  /** File-upload path only: the export says this post never published at
   * the source (a draft, or — Substack's CSV specifically — unpublished). */
  unpublishedAtSource?: boolean;
};

/** Which export format an uploaded file was recognized as — drives the
 * picker's copy and, for Substack/Ghost, whether the optional host input
 * feeds a reconstructed provenance link. */
type FileFormat = "substack" | "medium" | "ghost" | "wordpress";

type ImportFeed = {
  kind: "feed" | "file";
  format?: FileFormat;
  feed: { title: string; url: string };
  totalItems: number;
  draftSlotsRemaining: number;
  items: ImportItem[];
  /** File-upload path only: per-entry failures, the archive-cap cut, and
   * honest non-post skip counts (pages, attachments, responses/comments —
   * whichever the format carries), reported plainly rather than silently
   * imported as posts. */
  file?: {
    failures: number;
    truncated: number;
    withoutProvenance: boolean;
    skipped: { label: string; count: number }[];
  };
};

const FETCH_ERRORS: Record<string, string> = {
  invalid_url:
    "That doesn't look like an address we can fetch — it needs to be a public https:// page or feed.",
  fetch_failed:
    "That address couldn't be reached right now — check it for typos, or try again in a moment.",
  feed_too_large: "That feed is too large to import in one go (over 2 MB).",
  not_a_feed:
    "That address didn't answer with a feed — we tried /feed and /rss/ too. beehiiv writers: your feed URL is in Settings → RSS.",
  rate_limited:
    "That's a lot of feed fetches in one hour — take a breather and try again soon. Your drafts are unaffected.",
  not_signed_in: "Your session expired — sign in again to import.",
  unsupported_file_type:
    "We can only read a Substack or Medium export .zip, a Ghost export .json, or a WordPress export .xml file.",
  zip_too_large:
    "That zip is over 50 MB — post-only exports are usually a few MB. Make sure you picked the export file itself, not a full media backup.",
  zip_unreadable:
    "That file couldn't be read as a zip archive — re-download your export and try again.",
  not_an_export:
    "We couldn't find any posts in that zip — a Substack export keeps them in a posts/ folder, and so does a Medium export. Re-download your export and try again.",
  zip_too_many_files:
    "That zip holds far more files than a posts export carries, so we stopped before reading it. Make sure you picked the export file itself.",
  json_too_large:
    "That file is over 30 MB — a Ghost content export is usually much smaller.",
  not_a_ghost_export:
    "We couldn't find any posts in that file — a Ghost export keeps them in a posts array. Re-export from Settings → Advanced → Import/export and try again.",
  xml_too_large:
    "That file is over 30 MB — a WordPress export is usually much smaller.",
  not_a_wxr_export:
    "We couldn't find any posts in that file — only pages, attachments, or neither. Re-export from Tools → Export in WordPress and try again.",
  status_failed:
    "Your export was read, but checking it against your drafts failed — try again in a moment.",
};

/** Is this address (or its hostname) a substack.com publication? Used to
 * choose the honest error: Substack refuses all fetches from our server, so
 * "try again" would be a lie — the export upload is the working path. */
export function isSubstackHost(raw: string): boolean {
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    ? raw
    : `https://${raw}`;
  try {
    const host = new URL(candidate).hostname;
    return host === "substack.com" || host.endsWith(".substack.com");
  } catch {
    return false;
  }
}

export type SourceError = { code: string; url?: string };

/** The one error the retry-shaped copy would misdescribe: the host is
 * refusing our server, and the export upload is the path that works. */
function isBlockedError(error: SourceError): boolean {
  return (
    error.code === "upstream_blocked" ||
    ((error.code === "fetch_failed" || error.code === "not_a_feed") &&
      isSubstackHost(error.url ?? ""))
  );
}

function SourceErrorNotice({ error }: { error: SourceError }) {
  if (isBlockedError(error)) {
    const named = isSubstackHost(error.url ?? "");
    return (
      <Notice tone="alert">
        {named
          ? "Substack blocks automated fetching from our server. "
          : "That site is blocking automated fetching from our server. If it's a Substack publication (custom domains included), "}
        <a
          className="font-bold underline underline-offset-2"
          href="#substack-export"
        >
          {named
            ? "Upload your Substack export"
            : "upload your Substack export"}
        </a>{" "}
        instead — it works better anyway (your full archive, not just recent
        posts).
      </Notice>
    );
  }
  return (
    <Notice tone="alert">
      {FETCH_ERRORS[error.code] ?? "Something went wrong — try again."}
    </Notice>
  );
}

type ItemStatus =
  | { kind: "pending" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; reason: string };

type Phase = "source" | "pick" | "importing" | "done";
type Busy = null | "feed" | "reading" | "checking";

/** Does the conversion hold any actual content? BlockNote returns a single
 * empty paragraph for input it can't map (pinned in import-conversion.test),
 * so a length check alone would miss the "everything vanished" case. */
function isBlankConversion(blocks: unknown[]): boolean {
  return blocks.every((block) => {
    const b = block as {
      type?: string;
      content?: unknown;
      children?: unknown[];
    };
    return (
      b.type === "paragraph" &&
      Array.isArray(b.content) &&
      b.content.length === 0 &&
      (b.children ?? []).length === 0
    );
  });
}

/** Item HTML → editor blocks, in the browser. Unmappable content degrades to
 * visible plain text — imported words never vanish silently. */
function htmlToBlocks(
  editor: { tryParseHTMLToBlocks: (html: string) => unknown[] },
  html: string,
): unknown[] {
  let blocks: unknown[] = [];
  try {
    blocks = editor.tryParseHTMLToBlocks(html);
  } catch {
    blocks = [];
  }
  if (blocks.length > 0 && !isBlankConversion(blocks)) return blocks;
  const text =
    new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";
  return text.trim() === "" ? [] : [paragraphBlock(text.trim())];
}

function paragraphBlock(text: string) {
  return {
    type: "paragraph",
    content: [{ type: "text", text, styles: {} }],
  };
}

type ParsedFile = {
  format: FileFormat;
  sourceTitle: string;
  sourceUrl: string;
  totalItems: number;
  items: ImportItem[];
  fileMeta: NonNullable<ImportFeed["file"]>;
};
type ParseFileError = { code: string };

function skipLine(
  label: string,
  count: number,
): { label: string; count: number } {
  return { label, count };
}

/** The fields every format's parsed post already agrees on. What a format
 * calls its own id, and where its provenance link comes from, is the part
 * that genuinely differs — those arrive as functions below. */
type ParsedPost = {
  title: string;
  publishedAt: string | null;
  contentHtml: string;
  preview: boolean;
  publishedAtSource: boolean | null;
};

/**
 * Parsed posts → the picker's ImportItem, for every format.
 *
 * The nine fields of an ImportItem were assembled four times, identically
 * apart from two of them, in four adapters ~50 lines apart. That made adding
 * a field to ImportItem a four-file edit with no test to catch the one you
 * missed: the parser suites are per format and none of them run this
 * assembly. `guidHash` is passed in rather than imported so the adapters keep
 * their dynamic-import discipline — ~/lib/import pulls in a HTML parser, and
 * nothing about this page's first load should.
 */
async function toImportItems<TPost extends ParsedPost>(
  posts: TPost[],
  derive: {
    guid: (post: TPost) => string;
    link: (post: TPost) => string | null;
    guidHash: (guid: string) => Promise<string>;
  },
): Promise<ImportItem[]> {
  return Promise.all(
    posts.map(async (post): Promise<ImportItem> => {
      const guid = derive.guid(post);
      return {
        guid,
        guidHash: await derive.guidHash(guid),
        link: derive.link(post),
        title: post.title,
        publishedAt: post.publishedAt,
        contentHtml: post.contentHtml,
        preview: post.preview,
        alreadyImported: false,
        unpublishedAtSource: post.publishedAtSource === false,
      };
    }),
  );
}

async function parseSubstackFile(
  bytes: Uint8Array,
  hostInput: string,
): Promise<ParsedFile | ParseFileError> {
  const zip = await import("~/lib/import-zip");
  let parsed: import("~/lib/import-zip").ParsedExport;
  try {
    parsed = zip.parseSubstackExport(bytes);
  } catch (err) {
    return {
      code:
        err instanceof zip.ExportTooComplexError
          ? "zip_too_many_files"
          : "zip_unreadable",
    };
  }
  if (parsed.posts.length === 0) return { code: "not_an_export" };
  const host = zip.normalizeHost(hostInput);
  const items = await toImportItems(parsed.posts, {
    guid: (post) => zip.zipPostGuid(post.postId),
    link: (post) => zip.constructSourceUrl(host, post.slug),
    guidHash: zip.guidHash,
  });
  return {
    format: "substack",
    sourceTitle: "Your Substack export",
    sourceUrl: host ? `https://${host}` : "",
    totalItems: parsed.posts.length + parsed.truncated,
    items,
    fileMeta: {
      failures: parsed.failures.length,
      truncated: parsed.truncated,
      withoutProvenance: host === null,
      skipped: [],
    },
  };
}

async function parseMediumFile(
  bytes: Uint8Array,
): Promise<ParsedFile | ParseFileError> {
  const medium = await import("~/lib/import-medium");
  let parsed: import("~/lib/import-medium").ParsedMediumExport;
  try {
    parsed = medium.parseMediumExport(bytes);
  } catch (err) {
    return {
      code:
        err instanceof medium.ExportTooComplexError
          ? "zip_too_many_files"
          : "zip_unreadable",
    };
  }
  if (parsed.posts.length === 0) return { code: "not_an_export" };
  const items = await toImportItems(parsed.posts, {
    guid: (post) => medium.mediumPostGuid(post.fileSlug),
    link: (post) => post.link,
    guidHash: medium.guidHash,
  });
  return {
    format: "medium",
    sourceTitle: "Your Medium export",
    sourceUrl: "",
    totalItems: parsed.posts.length + parsed.truncated,
    items,
    fileMeta: {
      failures: parsed.failures.length,
      truncated: parsed.truncated,
      withoutProvenance: false,
      skipped:
        parsed.skippedResponses > 0
          ? [skipLine("responses/comments", parsed.skippedResponses)]
          : [],
    },
  };
}

async function parseGhostFile(
  text: string,
  hostInput: string,
): Promise<ParsedFile | ParseFileError> {
  const ghost = await import("~/lib/import-ghost");
  const parsed = ghost.parseGhostExport(text);
  if (parsed.posts.length === 0) return { code: "not_a_ghost_export" };
  const host = ghost.normalizeHost(hostInput);
  const items = await toImportItems(parsed.posts, {
    guid: (post) => ghost.ghostPostGuid(post.id),
    link: (post) => ghost.constructGhostSourceUrl(host, post.slug),
    guidHash: ghost.guidHash,
  });
  return {
    format: "ghost",
    sourceTitle: "Your Ghost export",
    sourceUrl: host ? `https://${host}` : "",
    totalItems: parsed.posts.length + parsed.truncated,
    items,
    fileMeta: {
      failures: parsed.failures.length,
      truncated: parsed.truncated,
      withoutProvenance: host === null,
      skipped:
        parsed.skippedPages > 0 ? [skipLine("pages", parsed.skippedPages)] : [],
    },
  };
}

async function parseWordPressFile(
  text: string,
): Promise<ParsedFile | ParseFileError> {
  const wxr = await import("~/lib/import-wxr");
  const parsed = wxr.parseWxrExport(text);
  if (parsed.malformed) return { code: "not_a_wxr_export" };
  if (parsed.posts.length === 0) return { code: "not_a_wxr_export" };
  const items = await toImportItems(parsed.posts, {
    guid: (post) => wxr.wordpressPostGuid(post.id),
    link: (post) => post.link,
    guidHash: wxr.guidHash,
  });
  const skipped = [
    ...(parsed.skipped.pages > 0
      ? [skipLine("pages", parsed.skipped.pages)]
      : []),
    ...(parsed.skipped.attachments > 0
      ? [skipLine("attachments", parsed.skipped.attachments)]
      : []),
    ...(parsed.skipped.other > 0
      ? [skipLine("other content types", parsed.skipped.other)]
      : []),
  ];
  return {
    format: "wordpress",
    sourceTitle: "Your WordPress export",
    sourceUrl: "",
    totalItems: parsed.posts.length + parsed.truncated,
    items,
    fileMeta: {
      failures: 0,
      truncated: parsed.truncated,
      withoutProvenance: false,
      skipped,
    },
  };
}

/**
 * File-upload dispatch: detects the format (~/lib/import-formats, a cheap
 * dependency-free check — zip variant needs a directory listing, so
 * ~/lib/zip-safety is imported first just for that), then hands the bytes
 * to the matching parser. Every heavier module (fflate, this route's own
 * per-format parsers) loads only past this point — never in the initial
 * bundle, never for a format the writer didn't upload.
 */
async function parseUploadedFile(
  file: File,
  hostInput: string,
): Promise<ParsedFile | ParseFileError> {
  const kind = detectFileKind(file);
  if (kind === "unsupported") return { code: "unsupported_file_type" };

  if (kind === "zip") {
    if (file.size > MAX_EXPORT_ZIP_BYTES) return { code: "zip_too_large" };
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { listZipEntries } = await import("~/lib/zip-safety");
    let entryNames: string[];
    try {
      entryNames = listZipEntries(bytes);
    } catch {
      return { code: "zip_unreadable" };
    }
    const variant = detectZipVariant(entryNames);
    if (variant === "substack") return parseSubstackFile(bytes, hostInput);
    if (variant === "medium") return parseMediumFile(bytes);
    return { code: "not_an_export" };
  }

  if (kind === "json") {
    if (file.size > MAX_EXPORT_TEXT_BYTES) return { code: "json_too_large" };
    return parseGhostFile(await file.text(), hostInput);
  }

  // kind === "xml"
  if (file.size > MAX_EXPORT_TEXT_BYTES) return { code: "xml_too_large" };
  return parseWordPressFile(await file.text());
}

function ImportPage() {
  const { ident } = Route.useLoaderData();
  const [phase, setPhase] = useState<Phase>("source");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<SourceError | null>(null);
  const [data, setData] = useState<ImportFeed | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<Record<string, ItemStatus>>({});

  function showPicker(next: ImportFeed) {
    setData(next);
    // Default selection: every NEW, full item, capped at the drafts headroom
    // (previews and already-imported items start unchecked — a preview
    // import is a deliberate act, never an accident).
    setSelected(
      new Set(
        next.items
          .filter((item) => !item.preview && !item.alreadyImported)
          .slice(0, next.draftSlotsRemaining)
          .map((item) => item.guidHash),
      ),
    );
    setStatus({});
    setError(null);
    setPhase("pick");
  }

  async function findPosts(url: string) {
    if (busy) return;
    setBusy("feed");
    setError(null);
    try {
      const res = await fetch("/api/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const body = (await res.json()) as
        | ({ ok: true } & Omit<ImportFeed, "kind">)
        | { ok: false; error?: string };
      if (!body.ok) {
        setError({ code: body.error ?? "fetch_failed", url });
        return;
      }
      showPicker({ ...body, kind: "feed" });
    } catch {
      setError({ code: "fetch_failed", url });
    } finally {
      setBusy(null);
    }
  }

  async function readExportFile(file: File, hostInput: string) {
    if (busy) return;
    setBusy("reading");
    setError(null);
    try {
      const parsed = await parseUploadedFile(file, hostInput);
      if ("code" in parsed) {
        setError({ code: parsed.code });
        return;
      }
      setBusy("checking");
      const res = await fetch("/api/import/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          guidHashes: parsed.items.map((item) => item.guidHash),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as
        | {
            ok: true;
            draftSlotsRemaining: number;
            alreadyImported: string[];
          }
        | { ok?: false; error?: string };
      if (!("ok" in body) || body.ok !== true) {
        setError({
          code:
            body.error === "not_signed_in" ? "not_signed_in" : "status_failed",
        });
        return;
      }
      const imported = new Set(body.alreadyImported);
      showPicker({
        kind: "file",
        format: parsed.format,
        feed: { title: parsed.sourceTitle, url: parsed.sourceUrl },
        totalItems: parsed.totalItems,
        draftSlotsRemaining: body.draftSlotsRemaining,
        items: parsed.items.map((item) => ({
          ...item,
          alreadyImported: imported.has(item.guidHash),
        })),
        file: parsed.fileMeta,
      });
    } catch {
      setError({ code: "zip_unreadable" });
    } finally {
      setBusy(null);
    }
  }

  function toggle(hash: string) {
    setSelected((old) => {
      const next = new Set(old);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      return next;
    });
  }

  async function runImport() {
    if (!data) return;
    const picked = data.items.filter((item) => selected.has(item.guidHash));
    if (picked.length === 0) return;
    setPhase("importing");
    setStatus(
      Object.fromEntries(
        picked.map((item) => [item.guidHash, { kind: "pending" as const }]),
      ),
    );
    // The editor bundle loads only when an import actually runs.
    const { BlockNoteEditor } = await import("@blocknote/core");
    const editor = BlockNoteEditor.create();
    const setOne = (hash: string, s: ItemStatus) =>
      setStatus((old) => ({ ...old, [hash]: s }));

    let imported = 0;
    let limitHit = false;
    for (const item of picked) {
      if (limitHit) {
        setOne(item.guidHash, { kind: "skipped", reason: "draft limit" });
        continue;
      }
      setOne(item.guidHash, { kind: "saving" });
      try {
        const blocks = htmlToBlocks(editor, item.contentHtml);
        if (item.preview && item.link) {
          // Honest excerpt marker: the writer sees where the rest lives.
          blocks.push(
            paragraphBlock(
              `The full post is at ${item.link} — paste the rest in, or leave the excerpt.`,
            ),
          );
        }
        const res = await fetch("/api/import/draft", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: item.title,
            content: blocks,
            source: {
              guid: item.guid,
              link: item.link,
              publishedAt: item.publishedAt,
            },
          }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
        };
        if (res.ok && body.ok) {
          imported++;
          setOne(item.guidHash, { kind: "saved" });
        } else if (body.error === "draft_limit") {
          limitHit = true;
          setOne(item.guidHash, { kind: "skipped", reason: "draft limit" });
        } else if (body.error === "already_imported") {
          setOne(item.guidHash, {
            kind: "skipped",
            reason: "already in your drafts",
          });
        } else if (body.error === "too_large") {
          setOne(item.guidHash, {
            kind: "failed",
            reason: "too long for a single draft",
          });
        } else {
          setOne(item.guidHash, { kind: "failed", reason: "couldn't save" });
        }
      } catch {
        setOne(item.guidHash, {
          kind: "failed",
          reason: "couldn't save — network hiccup",
        });
      }
    }
    capture("import_completed", {
      imported,
      picked: picked.length,
      totalItems: data.totalItems,
      source: data.kind,
    });
    setPhase("done");
  }

  return (
    // No active row: importing is a task you perform on your archive, reached
    // from the posts manager's toolbar — not one of the rail's places.
    <AppShell header={{ variant: "signed-in", ident }}>
      <main className="mx-auto w-full max-w-2xl px-6 py-10">
        <h1 className="font-black font-display text-3xl text-ink tracking-tight">
          Import your writing
        </h1>
        <p className="mt-2 max-w-[54ch] text-ink-soft">
          Bring your posts over as private drafts — nothing publishes until you
          say so. You don't have to migrate day one: imported posts mirror your
          originals, the source stays untouched, and readers are pointed to the
          original until you say otherwise.
        </p>
        <noscript>
          <p className="mt-6 border border-ink px-4 py-3 font-display text-ink text-sm">
            Importing converts your posts in the browser, so it needs
            JavaScript.
          </p>
        </noscript>

        {phase === "source" && (
          <SourcePicker
            busy={busy}
            error={error}
            onFeed={findPosts}
            onFile={readExportFile}
          />
        )}

        {phase === "pick" && data && (
          <PickList
            data={data}
            onBack={() => {
              setPhase("source");
              setData(null);
              setError(null);
            }}
            onImport={runImport}
            onToggle={toggle}
            selected={selected}
          />
        )}

        {(phase === "importing" || phase === "done") && data && (
          <ProgressList
            data={data}
            done={phase === "done"}
            selected={selected}
            status={status}
          />
        )}
      </main>
    </AppShell>
  );
}

/**
 * Step 1, both doors: paste a feed address, or upload an export file.
 * Exported for tests (import-page.test.tsx) — not a route.
 */
export function SourcePicker({
  busy,
  error,
  onFeed,
  onFile,
}: {
  busy: Busy;
  error: SourceError | null;
  onFeed: (url: string) => void;
  onFile: (file: File, host: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [host, setHost] = useState("");
  const [dragging, setDragging] = useState(false);
  const reading = busy === "reading" || busy === "checking";

  return (
    <>
      <form
        className="mt-8"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) onFeed(url.trim());
        }}
      >
        <label
          className="font-bold font-display text-ink text-sm"
          htmlFor="feed-url"
        >
          Paste your publication's address (or its RSS feed)
        </label>
        <p className="mt-1 max-w-[54ch] font-display text-ink-soft text-sm">
          Ghost, Medium, WordPress, beehiiv — anywhere with a feed. Feeds carry
          your most recent posts.
        </p>
        <div className="mt-2 flex flex-wrap gap-3">
          <input
            className="min-h-11 min-w-0 flex-1 border border-ink bg-paper px-4 py-2.5 font-body text-base text-ink placeholder:text-ink-soft"
            id="feed-url"
            inputMode="url"
            onChange={(event) => setUrl(event.currentTarget.value)}
            placeholder="https://your.publication.com"
            required
            type="text"
            value={url}
          />
          <button
            className="min-h-11 cursor-pointer bg-spot px-6 py-2.5 font-bold font-display text-base text-paper transition-colors hover:bg-ink disabled:cursor-default disabled:opacity-40"
            disabled={busy !== null}
            type="submit"
          >
            Find my posts
          </button>
        </div>
        {error && <SourceErrorNotice error={error} />}
        {busy === "feed" && (
          <div
            aria-label="Looking for your posts"
            aria-live="polite"
            role="status"
          >
            <div className="mt-6 animate-pulse space-y-3 motion-reduce:animate-none">
              <div className="h-4 w-full bg-rule/50" />
              <div className="h-4 w-11/12 bg-rule/50" />
              <div className="h-4 w-3/5 bg-rule/50" />
            </div>
            <p className="sr-only">Looking for your posts…</p>
          </div>
        )}
      </form>

      <section aria-labelledby="substack-export" className="mt-10">
        <h2
          className="border-rule border-t pt-6 font-bold font-display text-ink text-sm"
          id="substack-export"
        >
          Or upload your export
        </h2>
        <p className="mt-1 max-w-[54ch] font-display text-ink-soft text-sm">
          Substack (Settings → Exports), Medium, Ghost (Settings → Advanced →
          Import/export), or WordPress (Tools → Export) — upload the export file
          and it's read right here in your browser, never uploaded. It carries
          your whole archive, not just recent posts.
        </p>
        <label
          className="mt-3 block max-w-[54ch] font-display text-ink-soft text-sm"
          htmlFor="pub-host"
        >
          Your publication's address{" "}
          <span className="text-ink-soft/80">
            (optional, for Substack and Ghost exports — with it, each draft
            keeps a link to its original; Medium and WordPress exports already
            carry their own link, and this is unused for those)
          </span>
        </label>
        <input
          className="mt-2 min-h-11 w-full max-w-xs border border-ink bg-paper px-4 py-2.5 font-body text-base text-ink placeholder:text-ink-soft"
          id="pub-host"
          onChange={(event) => setHost(event.currentTarget.value)}
          placeholder="you.substack.com"
          type="text"
          value={host}
        />
        {reading ? (
          <div
            aria-live="polite"
            className="mt-4 border border-ink border-dashed px-6 py-8 font-display text-ink text-sm"
            role="status"
          >
            {busy === "reading"
              ? "Reading your export — the file stays on your machine…"
              : "Checking your posts against your existing drafts…"}
          </div>
        ) : (
          // biome-ignore lint/a11y/noStaticElementInteractions: drag-drop is a pointer-only convenience — the accessible path is the labeled file input inside; keyboard/AT users never need this surface
          <div
            className={`mt-4 border border-dashed px-6 py-8 text-center ${
              dragging ? "border-spot bg-spot/5" : "border-ink"
            }`}
            onDragLeave={() => setDragging(false)}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              const file = event.dataTransfer.files?.[0];
              if (file && !busy) onFile(file, host);
            }}
          >
            <label
              className="inline-flex min-h-11 cursor-pointer items-center bg-ink px-6 font-bold font-display text-base text-paper transition-colors hover:bg-spot"
              htmlFor="export-file"
            >
              Choose your export file
              <input
                accept=".zip,.json,.xml,application/zip,application/x-zip-compressed,application/json,text/xml,application/xml"
                className="sr-only"
                id="export-file"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (file && !busy) onFile(file, host);
                }}
                type="file"
              />
            </label>
            <p className="mt-3 font-display text-ink-soft text-sm">
              or drag it here — zip up to 50 MB, JSON/XML up to 30 MB
            </p>
          </div>
        )}
      </section>
    </>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block border border-ink-soft px-1.5 py-0.5 font-display font-semibold text-[0.65rem] text-ink-soft uppercase tracking-[0.08em]">
      {children}
    </span>
  );
}

/** "3 pages and 41 attachments skipped" — the honest non-post skip notice
 * every file format (WordPress pages/attachments, Ghost pages, Medium
 * responses/comments) surfaces the same way. Null when nothing was skipped. */
function formatSkipped(
  skipped: { label: string; count: number }[],
): string | null {
  if (skipped.length === 0) return null;
  const parts = skipped.map((s) => `${s.count} ${s.label}`);
  if (parts.length === 1) return `${parts[0]} skipped`;
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)} skipped`;
}

function PickList({
  data,
  selected,
  onToggle,
  onImport,
  onBack,
}: {
  data: ImportFeed;
  selected: Set<string>;
  onToggle: (hash: string) => void;
  onImport: () => void;
  onBack: () => void;
}) {
  const full = data.items.filter((item) => !item.preview).length;
  const previews = data.items.length - full;
  const count = selected.size;
  const overCap = count > data.draftSlotsRemaining;
  const isFile = data.kind === "file";
  const skippedNotice = data.file ? formatSkipped(data.file.skipped) : null;
  return (
    <section aria-labelledby="picker-heading" className="mt-8">
      <h2
        className="border-rule border-b pb-2 font-display font-semibold text-ink-soft text-xs uppercase tracking-[0.08em]"
        id="picker-heading"
      >
        {data.feed.title ? `${data.feed.title} · ` : ""}
        {isFile
          ? `found ${data.items.length} ${data.items.length === 1 ? "post" : "posts"} in your archive`
          : `found your ${data.items.length} most recent ${data.items.length === 1 ? "post" : "posts"}${
              data.totalItems <= data.items.length
                ? " (that's everything the feed carries)"
                : ` of ${data.totalItems} in the feed`
            }`}{" "}
        — {full} full, {previews}{" "}
        {previews === 1 ? "flagged as a preview" : "flagged as previews"}
      </h2>
      {!isFile && data.items.length >= 20 && (
        <p className="mt-2 font-display text-ink-soft text-sm">
          Feeds carry a recent window, not the archive — writers on Substack,
          Ghost, Medium, or WordPress can go back and upload their export to
          bring everything.
        </p>
      )}
      {isFile && data.file && data.file.truncated > 0 && (
        <p className="mt-2 font-display text-ink-soft text-sm">
          Your archive holds {data.totalItems} posts — one upload reads the
          first {data.items.length}. For the rest, export the remaining posts on
          their own and upload that.
        </p>
      )}
      {isFile && skippedNotice && (
        <p className="mt-2 max-w-[54ch] font-display text-ink-soft text-sm">
          {skippedNotice} — never imported as posts.
        </p>
      )}
      {isFile && data.file && data.file.failures > 0 && (
        <Notice tone="alert">
          {data.file.failures} {data.file.failures === 1 ? "file" : "files"} in
          the export couldn't be read and{" "}
          {data.file.failures === 1 ? "was" : "were"} skipped — the rest came
          through fine.
        </Notice>
      )}
      {isFile && data.file?.withoutProvenance && (
        <p className="mt-2 max-w-[54ch] font-display text-ink-soft text-sm">
          No publication address given, so these import as plain drafts — no
          link back to the originals. Go back and add it if you want each draft
          to keep one.
        </p>
      )}
      {overCap && (
        <Notice tone="alert">
          You have room for {data.draftSlotsRemaining}{" "}
          {data.draftSlotsRemaining === 1 ? "draft" : "drafts"} — importing{" "}
          {count} will stop at the limit. Publish or delete some drafts to make
          room.
        </Notice>
      )}
      <ul>
        {data.items.map((item) => {
          const date = formatDate(item.publishedAt ?? undefined);
          return (
            <li
              className="flex flex-wrap items-center gap-x-3 gap-y-1 border-rule border-b py-3"
              key={item.guidHash}
            >
              <label className="flex min-h-9 flex-1 cursor-pointer items-center gap-3">
                <input
                  checked={selected.has(item.guidHash)}
                  disabled={item.alreadyImported}
                  onChange={() => onToggle(item.guidHash)}
                  type="checkbox"
                />
                <span className="font-semibold text-ink leading-snug">
                  {item.title.trim() || "(untitled)"}
                </span>
              </label>
              <span className="flex items-center gap-x-3 font-display text-ink-soft text-sm">
                {date && (
                  <time dateTime={item.publishedAt ?? undefined}>{date}</time>
                )}
                {item.unpublishedAtSource && !item.alreadyImported && (
                  <Badge>Unpublished</Badge>
                )}
                {item.preview && !item.alreadyImported && (
                  <Badge>
                    {isFile ? "Might be incomplete" : "Preview only"}
                  </Badge>
                )}
                {item.alreadyImported && <Badge>Already imported</Badge>}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="mt-6 flex flex-wrap items-center gap-4">
        <button
          className="min-h-11 cursor-pointer bg-spot px-6 py-2.5 font-bold font-display text-base text-paper transition-colors hover:bg-ink disabled:cursor-default disabled:opacity-40"
          disabled={count === 0}
          onClick={onImport}
          type="button"
        >
          Import {count} to drafts
        </button>
        <button
          className="min-h-9 cursor-pointer font-display text-ink-soft text-sm underline underline-offset-2 transition-colors hover:text-ink"
          onClick={onBack}
          type="button"
        >
          {isFile ? "Start over" : "Try a different address"}
        </button>
      </div>
      <p className="mt-3 font-display text-ink-soft text-xs">
        {isFile
          ? "Flagged posts look too short to be complete — often a paywalled stub in the export. They import exactly as they are when you check them."
          : "Previews hold only what the feed shared — paywalled posts arrive as excerpts, flagged so nothing partial slips out as if it were whole."}
      </p>
    </section>
  );
}

function ProgressList({
  data,
  selected,
  status,
  done,
}: {
  data: ImportFeed;
  selected: Set<string>;
  status: Record<string, ItemStatus>;
  done: boolean;
}) {
  const rows = data.items.filter((item) => selected.has(item.guidHash));
  const saved = rows.filter(
    (item) => status[item.guidHash]?.kind === "saved",
  ).length;
  const skipped = rows.length - saved;
  let sourceHost: string | null = null;
  try {
    sourceHost = new URL(data.feed.url).hostname;
  } catch {
    sourceHost = null;
  }
  return (
    <section aria-labelledby="progress-heading" className="mt-8">
      <h2
        className="border-rule border-b pb-2 font-display font-semibold text-ink-soft text-xs uppercase tracking-[0.08em]"
        id="progress-heading"
      >
        {done
          ? `Imported ${saved} of ${rows.length}`
          : `Importing ${rows.length} ${rows.length === 1 ? "post" : "posts"}…`}
      </h2>
      <ul aria-live="polite">
        {rows.map((item) => {
          const s = status[item.guidHash] ?? { kind: "pending" };
          return (
            <li
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-rule border-b py-3"
              key={item.guidHash}
            >
              <span className="font-semibold text-ink leading-snug">
                {item.title.trim() || "(untitled)"}
              </span>
              {s.kind === "saving" || s.kind === "pending" ? (
                <span
                  aria-label="Saving"
                  className="h-4 w-24 animate-pulse bg-rule/50 motion-reduce:animate-none"
                  role="status"
                />
              ) : (
                <span className="font-display text-ink-soft text-sm">
                  {s.kind === "saved"
                    ? "Saved to drafts"
                    : s.kind === "skipped"
                      ? `Skipped — ${s.reason}`
                      : `Couldn't import — ${s.reason}`}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {done && (
        <div className="mt-6">
          <p className="max-w-[54ch] text-ink-soft leading-relaxed">
            {saved} {saved === 1 ? "draft" : "drafts"} saved
            {skipped > 0 ? `, ${skipped} skipped` : ""}.{" "}
            {sourceHost ? `${sourceHost} hasn't changed — ` : ""}publish the
            ones you want, whenever you want.
          </p>
          <a
            className="mt-4 inline-flex min-h-11 items-center bg-ink px-6 font-bold font-display text-base text-paper transition-colors hover:bg-spot"
            href="/dashboard"
          >
            Review your drafts
          </a>
        </div>
      )}
    </section>
  );
}
