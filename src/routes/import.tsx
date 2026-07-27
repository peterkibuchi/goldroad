/**
 * /import — one-time feed import (RSS/Atom → drafts). Writer surface in the
 * dashboard chrome family. The flow is paste → pick → import → done:
 *
 *  1. Paste: one field; the server tries the URL as a feed and autodiscovers
 *     (/feed, /rss/, link rel=alternate) when it gets HTML back.
 *  2. Pick: the found items — full posts checked by default, previews and
 *     already-imported items honestly flagged and unchecked. The header
 *     names the horizon plainly (feeds carry a window, not the archive).
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
import { useState } from "react";

import { formatDate } from "~/components/document-article";
import { Notice } from "~/components/notice";
import { AppShell } from "~/components/site-chrome";
import { resolveDidToHandle } from "~/lib/atproto";
import { capture } from "~/lib/posthog";
import { readSessionDid } from "~/lib/session";
import { env } from "cloudflare:workers";

const getImportViewer = createServerFn({ method: "GET" }).handler(async () => {
  const did = await readSessionDid(getRequest(), env.COOKIE_SECRET);
  if (!did) return null;
  const handle = await resolveDidToHandle(did).catch(() => null);
  return { ident: handle ?? did };
});

export const Route = createFileRoute("/import")({
  loader: async () => {
    const viewer = await getImportViewer();
    // Unauthed → /write, which renders the sign-in form (same as /dashboard).
    if (!viewer) throw redirect({ to: "/write" });
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
};

type ImportFeed = {
  feed: { title: string; url: string };
  totalItems: number;
  draftSlotsRemaining: number;
  items: ImportItem[];
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
};

type ItemStatus =
  | { kind: "pending" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; reason: string };

type Phase = "paste" | "fetching" | "pick" | "importing" | "done";

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

/** Feed-item HTML → editor blocks, in the browser. Unmappable content
 * degrades to visible plain text — imported words never vanish silently. */
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

function ImportPage() {
  const { ident } = Route.useLoaderData();
  const [phase, setPhase] = useState<Phase>("paste");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ImportFeed | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<Record<string, ItemStatus>>({});

  async function findPosts(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (phase === "fetching") return;
    setPhase("fetching");
    setError(null);
    try {
      const res = await fetch("/api/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      const body = (await res.json()) as
        | ({ ok: true } & ImportFeed)
        | { ok: false; error?: string };
      if (!body.ok) {
        setError(
          FETCH_ERRORS[body.error ?? ""] ?? "Something went wrong — try again.",
        );
        setPhase("paste");
        return;
      }
      setData(body);
      // Default selection: every NEW, full item — previews and
      // already-imported items start unchecked (a preview import is a
      // deliberate act, never an accident).
      setSelected(
        new Set(
          body.items
            .filter((item) => !item.preview && !item.alreadyImported)
            .map((item) => item.guidHash),
        ),
      );
      setStatus({});
      setPhase("pick");
    } catch {
      setError(FETCH_ERRORS.fetch_failed);
      setPhase("paste");
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
    });
    setPhase("done");
  }

  return (
    <AppShell header={{ variant: "signed-in", ident }}>
      <main className="mx-auto w-full max-w-2xl px-6 py-10">
        <h1 className="font-black font-display text-3xl text-ink tracking-tight">
          Import your writing
        </h1>
        <p className="mt-2 max-w-[54ch] text-ink-soft">
          Paste your publication's address — Substack, Ghost, Medium, WordPress,
          or anywhere with a feed. Your posts arrive here as private drafts;
          nothing publishes until you say so, and nothing changes at the source.
        </p>
        <noscript>
          <p className="mt-6 border border-ink px-4 py-3 font-display text-ink text-sm">
            Importing converts your posts in the browser, so it needs
            JavaScript.
          </p>
        </noscript>

        {(phase === "paste" || phase === "fetching") && (
          <form className="mt-8" onSubmit={findPosts}>
            <label
              className="font-bold font-display text-ink text-sm"
              htmlFor="feed-url"
            >
              Your publication's address (or its RSS feed)
            </label>
            <div className="mt-2 flex flex-wrap gap-3">
              <input
                className="min-h-11 min-w-0 flex-1 border border-ink bg-paper px-4 py-2.5 font-body text-base text-ink placeholder:text-ink-soft"
                id="feed-url"
                inputMode="url"
                onChange={(event) => setUrl(event.currentTarget.value)}
                placeholder="https://you.substack.com"
                required
                type="text"
                value={url}
              />
              <button
                className="min-h-11 cursor-pointer bg-spot px-6 py-2.5 font-bold font-display text-base text-paper transition-colors hover:bg-ink disabled:cursor-default disabled:opacity-40"
                disabled={phase === "fetching"}
                type="submit"
              >
                Find my posts
              </button>
            </div>
            {error && <Notice tone="alert">{error}</Notice>}
            {phase === "fetching" && (
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
        )}

        {phase === "pick" && data && (
          <PickList
            data={data}
            onBack={() => {
              setPhase("paste");
              setData(null);
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

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block border border-ink-soft px-1.5 py-0.5 font-display font-semibold text-[0.65rem] text-ink-soft uppercase tracking-[0.08em]">
      {children}
    </span>
  );
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
  return (
    <section aria-labelledby="picker-heading" className="mt-8">
      <h2
        className="border-rule border-b pb-2 font-display font-semibold text-ink-soft text-xs uppercase tracking-[0.08em]"
        id="picker-heading"
      >
        {data.feed.title ? `${data.feed.title} · ` : ""}found your{" "}
        {data.items.length} most recent{" "}
        {data.items.length === 1 ? "post" : "posts"}
        {data.totalItems <= data.items.length
          ? " (that's everything the feed carries)"
          : ` of ${data.totalItems} in the feed`}{" "}
        — {full} full, {previews} {previews === 1 ? "preview" : "previews"}
      </h2>
      {data.items.length >= 20 && (
        <p className="mt-2 font-display text-ink-soft text-sm">
          Older posts can come across with the export-file import — on the
          roadmap.
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
                {item.preview && !item.alreadyImported && (
                  <Badge>Preview only</Badge>
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
          Try a different address
        </button>
      </div>
      <p className="mt-3 font-display text-ink-soft text-xs">
        Previews hold only what the feed shared — paywalled posts arrive as
        excerpts, flagged so nothing partial slips out as if it were whole.
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
