/**
 * /import/threads — turn the writer's OWN Bluesky threads into private drafts.
 *
 * A SIBLING of /import, not a third door on it, and the file name says so:
 * TanStack's trailing-underscore convention (`import_.threads`) gives the URL
 * `/import/threads` without making `/import` a layout route, so nothing about
 * that page moves.
 *
 * The two surfaces are deliberately separate because they are different acts.
 * /import brings a STRANGER'S publication across: its whole framing is "the
 * source stays untouched, readers are pointed at the original", it asks for an
 * address or a file, and it parses in the browser. This page has no source to
 * ask for — the writer's own identity IS the source, so it opens straight into
 * their threads — and its honest stance is the opposite one: these pages stay
 * the original, because a thread was never a canonical web page. Folding that
 * into /import would have meant hedging every line of its copy and putting a
 * third pipeline in a 1300-line route.
 *
 * The flow, three server calls per thread and not one of them a publish:
 *
 *  1. Find: /api/threads lists the threads in the recent window of the
 *     writer's own feed, newest first, with already-imported flags from the
 *     shared import ledger and the drafts headroom.
 *  2. Pick: full threads checked by default, capped at the headroom;
 *     already-imported ones flagged and unchecked.
 *  3. Import: per thread, /api/threads/assemble converts it to markdown, the
 *     BROWSER turns that into editor blocks, and /api/import/draft lands it as
 *     a private draft plus its ledger row in one atomic batch. One progress row
 *     per thread; a failure is one row's problem, never the run's.
 *
 * Nothing here announces, and nothing here publishes: announcing is an
 * explicit, separate act on /api/publish, which is what keeps a backfill of
 * twenty old threads out of the writer's followers' timelines.
 */
import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { drizzle } from "drizzle-orm/d1";
import { useCallback, useEffect, useRef, useState } from "react";

import { formatDate } from "~/components/document-article";
import { Notice } from "~/components/notice";
import { AppShell } from "~/components/site-chrome";
import { MAIN_CONTENT_ID } from "~/components/skip-link";
import { resolveDidToHandle } from "~/lib/atproto";
import { readLiveSessionDid } from "~/lib/live-session";
import { capture } from "~/lib/posthog";
import { env } from "cloudflare:workers";

const getThreadViewer = createServerFn({ method: "GET" }).handler(async () => {
  const did = await readLiveSessionDid(
    getRequest(),
    env.COOKIE_SECRET,
    drizzle(env.DB),
  );
  if (!did) return null;
  const handle = await resolveDidToHandle(did).catch(() => null);
  return { ident: handle ?? did };
});

export const Route = createFileRoute("/import_/threads")({
  loader: async () => {
    const viewer = await getThreadViewer();
    // Unauthed → /write, which renders the sign-in form (same as /dashboard
    // and /import), carrying this page as the destination to come back to.
    if (!viewer)
      throw redirect({ to: "/write", search: { returnTo: "/import/threads" } });
    return viewer;
  },
  head: () => ({
    meta: [
      { title: "Turn your threads into posts — Goldroad" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ThreadImportPage,
});

/** One thread exactly as /api/threads sends it. */
export type WireThread = {
  rootUri: string;
  guidHash: string;
  title: string;
  postCount: number;
  createdAt: string;
  url: string;
  alreadyImported: boolean;
};

type Discovery = {
  threads: WireThread[];
  draftSlotsRemaining: number;
  /** The AppView still had older pages — there may be threads past these. */
  truncated: boolean;
};

const FIND_ERRORS: Record<string, string> = {
  appview_failed:
    "Bluesky didn't answer just now — that's on their side, not yours. Try again in a moment.",
  rate_limited:
    "That's a lot of thread reading in one hour — take a breather and try again soon. Your drafts are unaffected.",
  not_signed_in: "Your session expired — sign in again to import.",
};

/**
 * Our own JSON endpoints are still network reads, and this page walks whatever
 * they answer with straight into `threads.filter` and `slice`. A server that
 * drifts — or an intercepting proxy answering with its own JSON — would surface
 * as an undefined-property crash partway through, with the writer's picked
 * threads and their progress rows gone. These guards route a drift into the
 * notice the page already knows how to show. Same discipline, and the same
 * helpers, as /import's response-shape checks.
 */
export function isOkBody(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { ok?: unknown }).ok === true
  );
}

export function errorCodeOf(body: unknown): string | null {
  const refusal = body as { error?: unknown } | null;
  return typeof refusal === "object" &&
    refusal !== null &&
    typeof refusal.error === "string"
    ? refusal.error
    : null;
}

function isWireThread(value: unknown): value is WireThread {
  const thread = value as WireThread | null;
  return (
    typeof thread === "object" &&
    thread !== null &&
    typeof thread.rootUri === "string" &&
    typeof thread.guidHash === "string" &&
    typeof thread.title === "string" &&
    typeof thread.postCount === "number" &&
    typeof thread.createdAt === "string" &&
    typeof thread.url === "string" &&
    typeof thread.alreadyImported === "boolean"
  );
}

/** The /api/threads success body. Exported for tests — not a route. */
export function isDiscoveryBody(body: unknown): body is Discovery {
  if (!isOkBody(body)) return false;
  const found = body as Partial<Discovery>;
  return (
    typeof found.draftSlotsRemaining === "number" &&
    typeof found.truncated === "boolean" &&
    Array.isArray(found.threads) &&
    found.threads.every(isWireThread)
  );
}

/** One assembled thread as /api/threads/assemble sends it. */
export type WireAssembled = {
  title: string;
  markdown: string;
  postCount: number;
  createdAt: string;
  sourceUrl: string;
  truncated: boolean;
  droppedVideo: boolean;
};

/** The /api/threads/assemble success body. Exported for tests — not a route. */
export function isAssembledBody(
  body: unknown,
): body is { thread: WireAssembled } {
  if (!isOkBody(body)) return false;
  const thread = (body as { thread?: Partial<WireAssembled> }).thread;
  return (
    typeof thread === "object" &&
    thread !== null &&
    typeof thread.title === "string" &&
    typeof thread.markdown === "string" &&
    thread.markdown.trim() !== "" &&
    typeof thread.createdAt === "string" &&
    typeof thread.sourceUrl === "string"
  );
}

type ItemStatus =
  | { kind: "pending" }
  | { kind: "reading" }
  | { kind: "saving" }
  /**
   * `notes` are things that came across imperfectly but still came across —
   * the thread saved, and something about it is worth knowing before the writer
   * publishes it. They ride on the SAVED state rather than becoming a skip,
   * because the draft is real and the alternative (saying nothing) means the
   * writer finds out from a reader.
   */
  | { kind: "saved"; notes: string[] }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; reason: string };

type Phase = "finding" | "pick" | "importing" | "done";

/**
 * Why a thread couldn't be assembled, in the writer's terms. Every one of
 * these names the problem and what it means for them — never a status code,
 * and never blame.
 */
const ASSEMBLE_REASONS: Record<string, string> = {
  not_a_thread: "no longer a thread on Bluesky",
  too_long: "too long for a single post",
  rate_limited: "too many threads read this hour",
  appview_failed: "Bluesky didn't answer",
  not_your_post: "not one of your posts",
};

const SAVE_REASONS: Record<string, string> = {
  draft_limit: "draft limit",
  already_imported: "already in your drafts",
  too_large: "too long for a single draft",
};

function ThreadImportPage() {
  const { ident } = Route.useLoaderData();
  const [phase, setPhase] = useState<Phase>("finding");
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Discovery | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<Record<string, ItemStatus>>({});
  // An import is two round trips per picked thread, so it can run for a long
  // while — leaving the page has to stop it, and nothing may paint rows that
  // are no longer mounted.
  const runRef = useRef<AbortController | null>(null);
  useEffect(() => () => runRef.current?.abort(), []);

  const find = useCallback(async () => {
    setPhase("finding");
    setError(null);
    try {
      const res = await fetch("/api/threads", { method: "POST" });
      const body: unknown = await res.json().catch(() => null);
      if (!isDiscoveryBody(body)) {
        // An honest refusal and a body we don't recognize land in the same
        // notice — with the server's own code when it named one.
        setError(errorCodeOf(body) ?? "appview_failed");
        return;
      }
      setData(body);
      // Default selection: every NEW thread, capped at the drafts headroom.
      setSelected(
        new Set(
          body.threads
            .filter((thread) => !thread.alreadyImported)
            .slice(0, body.draftSlotsRemaining)
            .map((thread) => thread.guidHash),
        ),
      );
      setStatus({});
      setPhase("pick");
    } catch {
      setError("appview_failed");
    }
  }, []);

  // The writer's own identity is the only input, so the list is fetched on
  // arrival rather than behind a button: there is nothing to ask them first.
  useEffect(() => {
    void find();
  }, [find]);

  function toggle(hash: string) {
    setSelected((old) => {
      const next = new Set(old);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      return next;
    });
  }

  function toggleAll() {
    if (!data) return;
    setSelected((old) =>
      old.size > 0
        ? new Set()
        : new Set(
            data.threads
              .filter((thread) => !thread.alreadyImported)
              .slice(0, data.draftSlotsRemaining)
              .map((thread) => thread.guidHash),
          ),
    );
  }

  async function runImport() {
    if (!data) return;
    const picked = data.threads.filter((thread) =>
      selected.has(thread.guidHash),
    );
    if (picked.length === 0) return;
    runRef.current?.abort();
    const run = new AbortController();
    runRef.current = run;
    setPhase("importing");
    setStatus(
      Object.fromEntries(
        picked.map((thread) => [thread.guidHash, { kind: "pending" as const }]),
      ),
    );
    // The editor bundle loads only when an import actually runs.
    const { BlockNoteEditor } = await import("@blocknote/core");
    if (run.signal.aborted) return;
    const editor = BlockNoteEditor.create();
    const setOne = (hash: string, next: ItemStatus) => {
      if (run.signal.aborted) return;
      setStatus((old) => ({ ...old, [hash]: next }));
    };

    let imported = 0;
    let limitHit = false;
    for (const thread of picked) {
      if (run.signal.aborted) return;
      if (limitHit) {
        setOne(thread.guidHash, { kind: "skipped", reason: "draft limit" });
        continue;
      }
      try {
        // Step 1 — assemble. A thread that fails here lands NOTHING: no draft
        // is written, so there is no half-imported piece to find later.
        setOne(thread.guidHash, { kind: "reading" });
        const assembleRes = await fetch("/api/threads/assemble", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ rootUri: thread.rootUri }),
          signal: run.signal,
        });
        const assembled: unknown = await assembleRes.json().catch(() => null);
        if (!isAssembledBody(assembled)) {
          const code = errorCodeOf(assembled);
          if (code === "rate_limited") limitHit = true;
          setOne(thread.guidHash, {
            kind: "failed",
            reason:
              (code && ASSEMBLE_REASONS[code]) ?? "couldn't read the thread",
          });
          continue;
        }

        // Step 2 — the browser's only job: markdown → editor blocks, the same
        // shape every draft in the app is stored as.
        setOne(thread.guidHash, { kind: "saving" });
        const blocks = await editor.tryParseMarkdownToBlocks(
          assembled.thread.markdown,
        );
        if (run.signal.aborted) return;
        const res = await fetch("/api/import/draft", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: assembled.thread.title,
            content: blocks,
            source: {
              // The root's at:// URI is the ledger's dedupe identity.
              guid: thread.rootUri,
              link: assembled.thread.sourceUrl,
              publishedAt: assembled.thread.createdAt,
              kind: "thread",
            },
          }),
          signal: run.signal,
        });
        const body: unknown = await res.json().catch(() => null);
        const failure = errorCodeOf(body);
        if (res.ok && isOkBody(body)) {
          imported++;
          // Both facts already crossed the wire on the assembled thread and were
          // being dropped here. One calm line each: what is missing from the
          // draft, in the writer's terms, stated once and not dressed up.
          const notes: string[] = [];
          if (assembled.thread.truncated)
            notes.push("some posts further down didn't come across");
          if (assembled.thread.droppedVideo)
            notes.push("a video couldn't come across");
          setOne(thread.guidHash, { kind: "saved", notes });
        } else if (failure === "draft_limit") {
          limitHit = true;
          setOne(thread.guidHash, { kind: "skipped", reason: "draft limit" });
        } else if (failure === "already_imported") {
          setOne(thread.guidHash, {
            kind: "skipped",
            reason: SAVE_REASONS.already_imported,
          });
        } else {
          setOne(thread.guidHash, {
            kind: "failed",
            reason: (failure && SAVE_REASONS[failure]) ?? "couldn't save",
          });
        }
      } catch {
        // An abort lands here too — that is the writer leaving, not a failure
        // to report on a page that is going away.
        if (run.signal.aborted) return;
        setOne(thread.guidHash, {
          kind: "failed",
          reason: "couldn't save — network hiccup",
        });
      }
    }
    if (run.signal.aborted) return;
    capture("import_completed", {
      imported,
      picked: picked.length,
      totalItems: data.threads.length,
      source: "threads",
    });
    setPhase("done");
  }

  return (
    // No active row: importing is a task you perform on your archive, reached
    // from the posts manager's toolbar — not one of the rail's places.
    <AppShell header={{ variant: "signed-in", ident }}>
      <main
        className="mx-auto w-full max-w-2xl px-6 py-10"
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
      >
        <h1 className="font-black font-display text-3xl text-ink tracking-tight">
          Turn your threads into posts
        </h1>
        <p className="mt-2 text-ink-soft">
          The long ones you've already written, brought over as private drafts —
          nothing publishes until you say so, and your posts on Bluesky stay
          exactly where they are.
        </p>
        <noscript>
          <p className="mt-6 border border-ink px-4 py-3 font-display text-ink text-sm">
            Importing converts your threads in the browser, so it needs
            JavaScript.
          </p>
        </noscript>

        {phase === "finding" && <FindingState error={error} onRetry={find} />}

        {phase === "pick" && data && (
          <ThreadPicker
            data={data}
            onImport={runImport}
            onToggle={toggle}
            onToggleAll={toggleAll}
            selected={selected}
          />
        )}

        {(phase === "importing" || phase === "done") && data && (
          <ThreadProgress
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

/** Skeletons, never a spinner (docs/DESIGN.md), and the error path that
 * replaces them. Exported for tests — not a route. */
export function FindingState({
  error,
  onRetry,
}: {
  error: string | null;
  onRetry: () => void;
}) {
  if (error) {
    return (
      <>
        <Notice tone="alert">
          {FIND_ERRORS[error] ?? "Something went wrong — try again."}
        </Notice>
        <button
          className="mt-6 min-h-11 cursor-pointer bg-ink px-6 py-2.5 font-bold font-display text-base text-paper transition-colors hover:bg-spot"
          onClick={onRetry}
          type="button"
        >
          Try again
        </button>
      </>
    );
  }
  return (
    <div aria-label="Looking for your threads" aria-live="polite" role="status">
      <div className="mt-8 animate-pulse space-y-6 motion-reduce:animate-none">
        {[0, 1, 2, 3].map((row) => (
          <div className="space-y-2" key={row}>
            <div className="h-4 w-full bg-rule/50" />
            <div className="h-3 w-2/5 bg-rule/50" />
          </div>
        ))}
      </div>
      <p className="sr-only">Looking for your threads…</p>
    </div>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block border border-ink-soft px-1.5 py-0.5 font-display font-semibold text-[0.7rem] text-ink-soft uppercase tracking-[0.08em]">
      {children}
    </span>
  );
}

/**
 * The pick step. Exported for tests (thread-import-page.test.tsx) — not a
 * route.
 *
 * The row carries two lines rather than /import's one, because a thread has no
 * title to put on a line: it has a first line, which is usually a whole
 * sentence, and a length. So the first line takes the title's weight and the
 * meta line under it leads with the post count — that count is the reason a
 * writer is on this page at all, and the fastest way to tell one thread from
 * another at a glance.
 */
export function ThreadPicker({
  data,
  selected,
  onToggle,
  onToggleAll,
  onImport,
}: {
  data: Discovery;
  selected: Set<string>;
  onToggle: (hash: string) => void;
  onToggleAll: () => void;
  onImport: () => void;
}) {
  const count = selected.size;
  const overCap = count > data.draftSlotsRemaining;
  const available = data.threads.filter((thread) => !thread.alreadyImported);

  if (data.threads.length === 0) {
    // Empty states teach the next step (docs/DESIGN.md) — and this one has to
    // explain the rule, because "no threads" is otherwise indistinguishable
    // from "this is broken" for a writer who posts every day.
    return (
      <section aria-labelledby="threads-empty" className="mt-8">
        <h2
          className="border-rule border-b pb-2 font-display font-semibold text-ink-soft text-xs uppercase tracking-[0.08em]"
          id="threads-empty"
        >
          No threads found
        </h2>
        <p className="mt-4 text-ink-soft leading-relaxed">
          A thread means one of your posts with at least one of your own replies
          chained onto it — that's the shape that becomes a piece worth keeping.
          Single posts, and replies to other people, stay where they are.
        </p>
        <p className="mt-3 font-display text-ink-soft text-sm">
          Bluesky shows a recent window of your posts rather than your whole
          history, so a thread from years back may not appear here.
        </p>
        <a
          className="mt-6 inline-flex min-h-11 items-center bg-ink px-6 font-bold font-display text-base text-paper transition-colors hover:bg-spot"
          href="/write"
        >
          Write something new
        </a>
      </section>
    );
  }

  return (
    <section aria-labelledby="threads-heading" className="mt-8">
      <h2
        className="border-rule border-b pb-2 font-display font-semibold text-ink-soft text-xs uppercase tracking-[0.08em]"
        id="threads-heading"
      >
        Found {data.threads.length}{" "}
        {data.threads.length === 1 ? "thread" : "threads"}
      </h2>
      <p className="mt-2 font-display text-ink-soft text-sm">
        {data.truncated
          ? "Bluesky shows a recent window of your posts, not your whole history — there may be older threads than these."
          : "That's every thread in the window Bluesky shows of your posts."}
      </p>
      {/* The good news, and the thing a writer can't tell from the list: unlike
          an import from someone else's publication, a thread import keeps the
          canonical here. Said before the import, because it is the reason this
          is worth doing rather than screenshotting. */}
      <p className="mt-2 font-display text-ink-soft text-sm">
        Each draft keeps a line pointing back at the thread it came from, and
        these pages stay the original — the same words, in the shape they should
        have been in. Pictures come across with their descriptions, copied into
        your own storage when you publish.
      </p>
      {overCap && (
        <Notice tone="alert">
          You have room for {data.draftSlotsRemaining}{" "}
          {data.draftSlotsRemaining === 1 ? "draft" : "drafts"} — importing{" "}
          {count} will stop at the limit. Publish or delete some drafts to make
          room.
        </Notice>
      )}
      <ul>
        {data.threads.map((thread) => {
          const date = formatDate(thread.createdAt);
          return (
            <li className="border-rule border-b py-3" key={thread.guidHash}>
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  checked={selected.has(thread.guidHash)}
                  className="mt-1.5"
                  disabled={thread.alreadyImported}
                  onChange={() => onToggle(thread.guidHash)}
                  type="checkbox"
                />
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold text-ink leading-snug">
                    {thread.title}
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-display text-ink-soft text-sm">
                    <span>
                      {thread.postCount}{" "}
                      {thread.postCount === 1 ? "post" : "posts"}
                    </span>
                    {date && <time dateTime={thread.createdAt}>{date}</time>}
                    {thread.alreadyImported && <Badge>Already imported</Badge>}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <div className="mt-6 flex flex-wrap items-center gap-4">
        {/* Ink, not spot: the rail's "New post" carries this surface family's
            one accent moment (docs/DESIGN.md). */}
        <button
          className="min-h-11 cursor-pointer bg-ink px-6 py-2.5 font-bold font-display text-base text-paper transition-colors hover:bg-spot disabled:cursor-default disabled:opacity-40"
          disabled={count === 0}
          onClick={onImport}
          type="button"
        >
          Import {count} to drafts
        </button>
        {available.length > 1 && (
          <button
            className="min-h-9 cursor-pointer font-display text-ink-soft text-sm underline underline-offset-2 transition-colors hover:text-ink"
            onClick={onToggleAll}
            type="button"
          >
            {count > 0 ? "Clear selection" : "Select all that fit"}
          </button>
        )}
        <a
          className="min-h-9 font-display text-ink-soft text-sm underline underline-offset-2 transition-colors hover:text-ink"
          href="/import"
        >
          Import from another publication instead
        </a>
      </div>
      <p className="mt-3 font-display text-ink-soft text-xs">
        Quotes of other people's posts come across as a link, never as their
        words inside yours. A thread carrying video can't be brought over whole
        — the words arrive, the video doesn't.
      </p>
    </section>
  );
}

/** The importing/done step. Exported for tests — not a route. */
export function ThreadProgress({
  data,
  selected,
  status,
  done,
}: {
  data: Discovery;
  selected: Set<string>;
  status: Record<string, ItemStatus>;
  done: boolean;
}) {
  const rows = data.threads.filter((thread) => selected.has(thread.guidHash));
  const saved = rows.filter(
    (thread) => status[thread.guidHash]?.kind === "saved",
  ).length;
  const skipped = rows.length - saved;
  return (
    <section aria-labelledby="thread-progress-heading" className="mt-8">
      <h2
        className="border-rule border-b pb-2 font-display font-semibold text-ink-soft text-xs uppercase tracking-[0.08em]"
        id="thread-progress-heading"
      >
        {done
          ? `Imported ${saved} of ${rows.length}`
          : `Importing ${rows.length} ${rows.length === 1 ? "thread" : "threads"}…`}
      </h2>
      <ul aria-live="polite">
        {rows.map((thread) => {
          const state = status[thread.guidHash] ?? { kind: "pending" };
          return (
            <li
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-rule border-b py-3"
              key={thread.guidHash}
            >
              <span className="min-w-0 flex-1 font-semibold text-ink leading-snug">
                {thread.title}
              </span>
              {state.kind === "pending" ||
              state.kind === "reading" ||
              state.kind === "saving" ? (
                <span
                  aria-label={
                    state.kind === "reading" ? "Reading thread" : "Saving"
                  }
                  className="h-4 w-24 animate-pulse bg-rule/50 motion-reduce:animate-none"
                  role="status"
                />
              ) : (
                <span className="font-display text-ink-soft text-sm">
                  {state.kind === "saved"
                    ? state.notes.length > 0
                      ? `Saved to drafts — ${state.notes.join("; ")}`
                      : "Saved to drafts"
                    : state.kind === "skipped"
                      ? `Skipped — ${state.reason}`
                      : `Couldn't import — ${state.reason}`}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {done && (
        <div className="mt-6">
          <p className="text-ink-soft leading-relaxed">
            {saved} {saved === 1 ? "draft" : "drafts"} saved
            {skipped > 0 ? `, ${skipped} skipped` : ""}. Your threads on Bluesky
            haven't changed — publish the ones you want, whenever you want.
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
