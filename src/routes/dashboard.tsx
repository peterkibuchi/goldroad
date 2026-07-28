import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { drizzle } from "drizzle-orm/d1";
import { useEffect, useRef, useState } from "react";

import { formatDate } from "~/components/document-article";
import { ExternalLink } from "~/components/external-link";
import { MovePublicationNotice } from "~/components/move-publication-notice";
import { Notice } from "~/components/notice";
import { AppShell } from "~/components/site-chrome";
import {
  isValidCursor,
  listRecords,
  listRecordsPage,
  resolveDidToHandle,
  resolveDidToPds,
  type StandardDocument,
  type StandardPublication,
} from "~/lib/atproto";
import { mapDashboardRows } from "~/lib/dashboard";
import { listDrafts } from "~/lib/drafts";
import { LEGACY_ORIGINS, ownOrigins } from "~/lib/origin";
import { capture } from "~/lib/posthog";
import { isOwnPublicationUrl, TID_RE } from "~/lib/publish";
import { readSessionDid } from "~/lib/session";
import { env } from "cloudflare:workers";

/** bsky.app profile/post URL. DIDs and handles go in RAW: bsky.app's router
 * rejects percent-encoded colons (`did%3Aplc%3A…` → "Invalid DID or handle"),
 * and both shapes are already URL-path-safe (validated upstream as isDid /
 * isHandle; TID rkeys are base32). */
function bskyPostUrl(actor: string, rkey: string): string {
  return `https://bsky.app/profile/${actor}/post/${rkey}`;
}

const ERROR_MESSAGES: Record<string, string> = {
  missing_rkey: "That action was missing its post. Try again from this page.",
  not_found: "That post isn't in your repo anymore.",
  delete_scope:
    "Deleting needs a permission your current sign-in doesn't include yet — re-connect your account to enable deletion.",
  announce_scope:
    "Posting to Bluesky needs a permission your current sign-in doesn't include yet — re-connect your account to enable announcing.",
  announce_no_url:
    "This post has no public URL to announce — it may belong to a publication Goldroad can't resolve right now.",
  move_no_publication:
    "There's no publication to move yet — it's created when you publish your first post.",
};

function errorMessage(code: string | undefined): string | null {
  if (!code) return null;
  if (code.startsWith("delete_failed:"))
    return `Deleting failed (${code.slice("delete_failed:".length)}). Try again.`;
  if (code.startsWith("announce_failed:"))
    return `Announcing failed (${code.slice("announce_failed:".length)}). Try again.`;
  if (code.startsWith("move_failed:"))
    return `Moving your publication failed (${code.slice("move_failed:".length)}). Try again.`;
  return ERROR_MESSAGES[code] ?? "Something went wrong. Try again.";
}

/** Scope errors are fixed by a fresh sign-in (new consent = new scope grant). */
function needsReconnect(code: string | undefined): boolean {
  return code === "delete_scope" || code === "announce_scope";
}

const getDashboard = createServerFn({ method: "GET" })
  .validator((data: { cursor?: string }) => ({
    cursor: isValidCursor(data.cursor) ? data.cursor : undefined,
  }))
  .handler(async ({ data }) => {
    const request = getRequest();
    const did = await readSessionDid(request, env.COOKIE_SECRET);
    if (!did) return null;
    const origin = new URL(request.url).origin;
    const handle = await resolveDidToHandle(did).catch(() => null);
    // The writer's own documents, straight from their PDS over public XRPC —
    // same read path the public publication page uses. A failed load stays
    // distinguishable from "no posts yet" (rows: null) so we never greet a
    // writer whose PDS flaked with a scary empty state.
    const pds = await resolveDidToPds(did).catch(() => null);
    // The PDS fan-out and the D1 drafts read run in one parallel batch —
    // neither depends on the other, so the page pays the slowest, not the sum.
    const [draftRows, [page, onLegacyUrl]] = await Promise.all([
      // The writer's private drafts, from our own D1 (they are never in the
      // repo — see /api/drafts). A failed read stays distinguishable from
      // "no drafts" (null, same policy as rows) so the section can say so
      // instead of implying the writer's drafts vanished.
      listDrafts(drizzle(env.DB), did).catch(() => null),
      pds
        ? Promise.all([
            listRecordsPage<StandardDocument>(
              pds,
              did,
              "site.standard.document",
              { cursor: data.cursor },
            ).catch(() => null),
            // Move-to-canonical affordance: is the writer's own publication still
            // on a legacy origin? Best-effort — a flaked read just hides the notice.
            listRecords<StandardPublication>(
              pds,
              did,
              "site.standard.publication",
              { reverse: true },
            )
              .then((pubs) => {
                const own = pubs.find((p) =>
                  isOwnPublicationUrl(p.value.url, ownOrigins(origin)),
                );
                return own
                  ? isOwnPublicationUrl(own.value.url, LEGACY_ORIGINS)
                  : false;
              })
              .catch(() => false),
          ])
        : ([null, false] as const),
    ]);
    return {
      ident: handle ?? did,
      handle,
      rows: page ? mapDashboardRows(page.records) : null,
      nextCursor: page?.cursor ?? null,
      onLegacyUrl,
      // ISO strings, not Dates: loader data must serialize identically on
      // server and client. null = the read flaked (not "no drafts").
      drafts:
        draftRows?.map((d) => ({
          id: d.id,
          title: d.title,
          updatedAt: d.updatedAt.toISOString(),
        })) ?? null,
    };
  });

export const Route = createFileRoute("/dashboard")({
  validateSearch: (search: Record<string, unknown>) => {
    const out: {
      error?: string;
      published?: string;
      announced?: string;
      deleted?: boolean;
      moved?: boolean;
      cursor?: string;
    } = {};
    if (typeof search.error === "string") out.error = search.error;
    // rkeys get interpolated into URLs below — only accept well-formed TIDs.
    if (typeof search.published === "string" && TID_RE.test(search.published))
      out.published = search.published;
    if (typeof search.announced === "string" && TID_RE.test(search.announced))
      out.announced = search.announced;
    if (search.deleted === "1" || search.deleted === 1) out.deleted = true;
    if (search.moved === "1" || search.moved === 1) out.moved = true;
    if (isValidCursor(search.cursor)) out.cursor = search.cursor;
    return out;
  },
  loaderDeps: ({ search }) => ({ cursor: search.cursor }),
  loader: async ({ deps }) => {
    const dashboard = await getDashboard({ data: { cursor: deps.cursor } });
    // Unauthed → /write, which renders the sign-in form.
    if (!dashboard) throw redirect({ to: "/write" });
    return dashboard;
  },
  head: () => ({
    meta: [
      { title: "Your posts — Goldroad" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: DashboardPage,
});

const ANNOUNCE_EXPLAINER =
  "Share this post to your Bluesky followers — it appears as a rich card linking here.";

function AnnounceButton({
  rkey,
  label,
  confirmMessage,
}: {
  rkey: string;
  label?: string;
  /** Set on already-announced posts: re-announcing is legal but deliberate. */
  confirmMessage?: string;
}) {
  return (
    <form
      action="/api/publish"
      className="inline"
      method="post"
      onSubmit={(event) => {
        if (confirmMessage && !window.confirm(confirmMessage))
          event.preventDefault();
      }}
    >
      <input name="intent" type="hidden" value="announce" />
      <input name="rkey" type="hidden" value={rkey} />
      <button
        className="-my-2 inline-flex min-h-9 cursor-pointer items-center font-display text-ink-soft text-sm underline underline-offset-2 transition-colors hover:text-ink"
        title={ANNOUNCE_EXPLAINER}
        type="submit"
      >
        {label ?? "Announce on Bluesky"}
      </button>
    </form>
  );
}

/**
 * Confirm-before-delete for a published post. Non-announced posts keep the
 * plain window.confirm. Announced posts get a real dialog instead: deleting
 * the document does NOT delete the Bluesky announcement (a separate record
 * in the writer's repo), so its card would point at a page that no longer
 * exists — that consequence needs plain words and a direct link to the
 * Bluesky post, which a confirm() line can't carry.
 * Exported for tests (dashboard-delete.test.tsx) — not a route.
 */
export function DeletePostForm({
  rkey,
  title,
  announced,
}: {
  rkey: string;
  title: string;
  announced: { did: string; postRkey: string } | null;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Set when the dialog's Delete button approved the submit, so the
  // re-entrant requestSubmit below passes straight through this handler.
  const approvedRef = useRef(false);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    if (approvedRef.current) return;
    if (announced) {
      event.preventDefault();
      dialogRef.current?.showModal();
      // Focus lands on the safe action, not the destructive one (or the
      // link, which showModal would otherwise pick as first-focusable).
      cancelRef.current?.focus();
      return;
    }
    if (
      !window.confirm(`Delete "${title}" from your repo? This can't be undone.`)
    )
      event.preventDefault();
  }

  return (
    <>
      <form
        action="/api/publish"
        className="inline"
        method="post"
        onSubmit={handleSubmit}
        ref={formRef}
      >
        <input name="intent" type="hidden" value="delete" />
        <input name="rkey" type="hidden" value={rkey} />
        <button
          className="-my-2 inline-flex min-h-9 cursor-pointer items-center font-display text-ink-soft text-sm underline underline-offset-2 transition-colors hover:text-spot"
          type="submit"
        >
          Delete
        </button>
      </form>
      {announced && (
        /* Native <dialog>: showModal gives the focus trap, Esc-to-close, and
           inert background for free. */
        <dialog
          aria-describedby={`delete-desc-${rkey}`}
          aria-labelledby={`delete-title-${rkey}`}
          className="m-auto w-full max-w-md border-2 border-ink bg-paper p-6 text-ink backdrop:bg-ink/50"
          ref={dialogRef}
          role="alertdialog"
        >
          <h2
            className="font-black font-display text-ink text-xl tracking-tight"
            id={`delete-title-${rkey}`}
          >
            Delete "{title}"?
          </h2>
          <p
            className="mt-3 text-ink-soft leading-relaxed"
            id={`delete-desc-${rkey}`}
          >
            This deletes the post from your repo — it can't be undone. Your
            announcement on Bluesky is a separate post and stays up: its card
            will point to a page that no longer exists.
          </p>
          <p className="mt-2 font-display text-sm">
            <ExternalLink
              className="underline underline-offset-2 transition-colors hover:text-spot"
              href={bskyPostUrl(announced.did, announced.postRkey)}
            >
              View the Bluesky post
            </ExternalLink>{" "}
            <span className="text-ink-soft">
              — you can delete it there too.
            </span>
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-4">
            <button
              className="min-h-11 cursor-pointer bg-spot px-6 font-bold font-display text-base text-paper transition-colors hover:bg-ink"
              onClick={() => {
                approvedRef.current = true;
                dialogRef.current?.close();
                formRef.current?.requestSubmit();
                // The submit event dispatches synchronously above; re-arm the
                // confirm in case the navigation never happens (network fail).
                approvedRef.current = false;
              }}
              type="button"
            >
              Delete the post
            </button>
            <button
              className="min-h-11 cursor-pointer font-display text-ink-soft text-sm underline underline-offset-2 transition-colors hover:text-ink"
              onClick={() => dialogRef.current?.close()}
              ref={cancelRef}
              type="button"
            >
              Cancel
            </button>
          </div>
        </dialog>
      )}
    </>
  );
}

type DraftListItem = { id: string; title: string; updatedAt: string };

/**
 * The writer's unpublished drafts — private to them, resumable in the editor.
 * Delete is a fetch (the drafts API is JSON, unlike the form-posting publish
 * intents) followed by a router invalidate to refresh the loader data;
 * confirm-before-delete and destructive hover match the posts list.
 * `drafts: null` = the read flaked — said honestly, never shown as "no
 * drafts" (same policy as the posts list).
 */
function DraftsSection({ drafts }: { drafts: DraftListItem[] | null }) {
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  if (drafts !== null && drafts.length === 0) return null;
  if (drafts === null) {
    return (
      <Notice tone="alert">
        Your drafts couldn't be loaded right now — they're safe; refresh to try
        again.
      </Notice>
    );
  }

  async function deleteDraft(draft: DraftListItem) {
    const name = draft.title.trim() || "(untitled draft)";
    if (!window.confirm(`Delete the draft "${name}"? This can't be undone.`))
      return;
    setFailed(false);
    try {
      const res = await fetch(
        `/api/drafts?id=${encodeURIComponent(draft.id)}`,
        { method: "DELETE" },
      );
      // 404 = already gone (another tab) — refreshing the list is the fix.
      if (!res.ok && res.status !== 404) throw new Error(String(res.status));
      await router.invalidate();
    } catch {
      setFailed(true);
    }
  }

  return (
    <section aria-labelledby="drafts-heading" className="mt-8">
      <h2
        className="border-rule border-b pb-2 font-display font-semibold text-ink-soft text-xs uppercase tracking-[0.08em]"
        id="drafts-heading"
      >
        {drafts.length} {drafts.length === 1 ? "draft" : "drafts"} · only you
        can see these
      </h2>
      {failed && (
        <Notice tone="alert">
          That draft couldn't be deleted right now. Try again.
        </Notice>
      )}
      <ul>
        {drafts.map((draft) => {
          const date = formatDate(draft.updatedAt);
          return (
            <li
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-rule border-b py-4"
              key={draft.id}
            >
              <span>
                <a
                  className="font-semibold text-ink leading-snug hover:underline hover:underline-offset-4"
                  href={`/write?draft=${encodeURIComponent(draft.id)}`}
                >
                  {draft.title.trim() || "(untitled draft)"}
                </a>
                {date && (
                  <span className="ml-3 font-display text-ink-soft text-sm">
                    <time dateTime={draft.updatedAt}>{date}</time>
                  </span>
                )}
              </span>
              <span className="flex flex-wrap items-center gap-x-4">
                <a
                  className="-my-2 inline-flex min-h-9 items-center font-display text-ink-soft text-sm underline underline-offset-2 transition-colors hover:text-ink"
                  href={`/write?draft=${encodeURIComponent(draft.id)}`}
                >
                  Resume
                </a>
                <button
                  className="-my-2 inline-flex min-h-9 cursor-pointer items-center font-display text-ink-soft text-sm underline underline-offset-2 transition-colors hover:text-spot"
                  onClick={() => void deleteDraft(draft)}
                  type="button"
                >
                  Delete
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function DashboardPage() {
  const { ident, handle, rows, nextCursor, onLegacyUrl, drafts } =
    Route.useLoaderData();
  const { error, published, announced, deleted, moved, cursor } =
    Route.useSearch();
  const message = errorMessage(error);

  // Analytics (cookieless, no-op without a PostHog key): the server redirects
  // land here with the result in the query string — the closest client-side
  // moment to the actual PDS write. Properties stay within DID/handle policy.
  useEffect(() => {
    if (published) capture("post_published", { rkey: published, ident });
  }, [published, ident]);
  useEffect(() => {
    if (announced) capture("post_announced", { rkey: announced, ident });
  }, [announced, ident]);

  return (
    <AppShell header={{ variant: "signed-in", ident, active: "posts" }}>
      <main className="mx-auto w-full max-w-2xl px-6 py-10">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="font-black font-display text-3xl text-ink tracking-tight">
              Your posts
            </h1>
            <p className="mt-2 max-w-[52ch] text-ink-soft">
              Everything published from your own data repo — including posts
              written in other apps.
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <a
              className="inline-flex min-h-11 items-center bg-spot px-5 font-bold font-display text-base text-paper transition-colors hover:bg-ink"
              href="/write"
            >
              New post
            </a>
            {/* Import entry point: writers arriving with an existing
                publication bring it with them (posts land as drafts). */}
            <a
              className="inline-flex min-h-9 items-center font-display text-ink-soft text-sm underline underline-offset-2 transition-colors hover:text-ink"
              href="/import"
            >
              Import your writing
            </a>
          </div>
        </div>

        {published && (
          <Notice tone="info">
            Published.{" "}
            {/* New tab: the writer keeps their dashboard context. */}
            <ExternalLink
              className="underline underline-offset-2"
              href={`/@${encodeURIComponent(ident)}/${published}`}
            >
              View it live
            </ExternalLink>
            <span className="mt-1 block">
              {ANNOUNCE_EXPLAINER} <AnnounceButton rkey={published} />
            </span>
          </Notice>
        )}
        {announced && (
          <Notice tone="info">
            Announced — your followers will see this post as a card that links
            back here.{" "}
            <ExternalLink
              className="underline underline-offset-2"
              href={bskyPostUrl(ident, announced)}
            >
              View your post on Bluesky
            </ExternalLink>
          </Notice>
        )}
        {deleted && <Notice tone="info">Deleted from your repo.</Notice>}
        {moved && (
          <Notice tone="info">
            Done — your publication now lives at trygoldroad.com. Old links
            redirect here.
          </Notice>
        )}
        {onLegacyUrl && !moved && (
          <MovePublicationNotice returnTo="dashboard" />
        )}
        {message && (
          <Notice tone="alert">
            {message}
            {needsReconnect(error) && handle && (
              <form action="/login" className="mt-2" method="post">
                <input name="handle" type="hidden" value={handle} />
                <input name="returnTo" type="hidden" value="/dashboard" />
                <button
                  className="cursor-pointer font-bold underline underline-offset-2"
                  type="submit"
                >
                  Re-connect your account
                </button>{" "}
                — you'll approve the new permission on your own server.
              </form>
            )}
          </Notice>
        )}

        <DraftsSection drafts={drafts} />

        {rows === null ? (
          <Notice tone="alert">
            Your posts couldn't be loaded right now — your data server may be
            briefly unreachable. They're safe in your repo; refresh to try
            again.
          </Notice>
        ) : rows.length > 0 ? (
          <>
            <p className="mt-8 border-rule border-b pb-2 font-display font-semibold text-ink-soft text-xs uppercase tracking-[0.08em]">
              {rows.length} {rows.length === 1 ? "post" : "posts"}
              {/* An honest count: a paginated view shows a page, not the archive. */}
              {cursor || nextCursor ? " on this page" : ""} · newest first
            </p>
            <ul>
              {rows.map((row) => {
                const date = formatDate(row.publishedAt ?? undefined);
                return (
                  <li className="border-rule border-b py-5" key={row.rkey}>
                    <a
                      className="font-semibold text-ink text-lg leading-snug hover:underline hover:underline-offset-4"
                      href={`/@${encodeURIComponent(ident)}/${encodeURIComponent(row.rkey)}`}
                    >
                      {row.title}
                    </a>
                    {row.description && (
                      <p className="mt-1 line-clamp-1 text-ink-soft text-sm leading-relaxed">
                        {row.description}
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                      <span className="font-display text-ink-soft text-sm">
                        {date && (
                          <time dateTime={row.publishedAt ?? undefined}>
                            {date}
                          </time>
                        )}
                        {row.updatedAt ? (date ? " · edited" : "Edited") : null}
                        {!row.editable && (
                          <span>{date ? " · " : ""}Written in another app</span>
                        )}
                      </span>
                      <span className="flex flex-wrap items-center gap-x-4">
                        {row.editable && (
                          <a
                            className="-my-2 inline-flex min-h-9 items-center font-display text-ink-soft text-sm underline underline-offset-2 transition-colors hover:text-ink"
                            href={`/write?edit=${encodeURIComponent(row.rkey)}`}
                          >
                            Edit
                          </a>
                        )}
                        {row.announced ? (
                          <>
                            <ExternalLink
                              className="-my-2 inline-flex min-h-9 items-center font-display text-ink-soft text-sm underline underline-offset-2 transition-colors hover:text-ink"
                              href={bskyPostUrl(
                                row.announced.did,
                                row.announced.postRkey,
                              )}
                              title="View the announcement post on Bluesky"
                            >
                              Announced ↗
                            </ExternalLink>
                            <AnnounceButton
                              confirmMessage="Already announced — post again?"
                              label="Announce again"
                              rkey={row.rkey}
                            />
                          </>
                        ) : (
                          <AnnounceButton label="Announce" rkey={row.rkey} />
                        )}
                        <DeletePostForm
                          announced={row.announced}
                          rkey={row.rkey}
                          title={row.title}
                        />
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
            {nextCursor && (
              <p className="mt-6">
                <a
                  className="font-display text-ink-soft text-sm underline underline-offset-2 transition-colors hover:text-ink"
                  href={`/dashboard?cursor=${encodeURIComponent(nextCursor)}`}
                >
                  Older posts →
                </a>
              </p>
            )}
          </>
        ) : (
          <div className="mt-10 border-2 border-ink p-8">
            <h2 className="font-black font-display text-ink text-xl tracking-tight">
              No posts yet.
            </h2>
            <p className="mt-3 max-w-[52ch] text-ink-soft leading-relaxed">
              Your first post publishes straight to your own data repo and goes
              live on your public page. Announce it and it reaches your Bluesky
              followers as a rich card linking back here.
            </p>
            <a
              className="mt-6 inline-flex min-h-11 items-center bg-ink px-6 font-bold font-display text-base text-paper transition-colors hover:bg-spot"
              href="/write"
            >
              Write your first post
            </a>
            <p className="mt-4 font-display text-ink-soft text-sm">
              Writing somewhere else?{" "}
              <a
                className="underline underline-offset-2 transition-colors hover:text-ink"
                href="/import"
              >
                Bring it with you
              </a>{" "}
              — your posts arrive as drafts, and nothing changes at the source.
            </p>
          </div>
        )}
      </main>
    </AppShell>
  );
}
