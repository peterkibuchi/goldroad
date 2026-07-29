import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { drizzle } from "drizzle-orm/d1";
import { useRef, useState } from "react";

import { ExternalLink } from "~/components/external-link";
import { MovePublicationNotice } from "~/components/move-publication-notice";
import { Notice } from "~/components/notice";
import { AppShell } from "~/components/site-chrome";
import {
  listRecords,
  resolveDidToHandle,
  resolveDidToPds,
  type StandardPublication,
} from "~/lib/atproto";
import { canonicalOrigin, LEGACY_ORIGINS, ownOrigins } from "~/lib/origin";
import {
  isOwnPublicationUrl,
  MAX_NAME_LENGTH,
  MAX_PUBLICATION_DESCRIPTION_LENGTH,
} from "~/lib/publish";
import { countDraftsForDid, countImportItemsForDid } from "~/lib/rights-store";
import { readSessionDid } from "~/lib/session";
import { env } from "cloudflare:workers";

const ERROR_MESSAGES: Record<string, string> = {
  missing_name: "Give your publication a name.",
  too_long: "That name or description is too long.",
  move_no_publication:
    "There's no publication to move yet — it's created when you publish your first post.",
  delete_account_failed:
    "Deleting your account didn't go through. Refresh the page and try again.",
};

function errorMessage(code: string | undefined): string | null {
  if (!code) return null;
  if (code.startsWith("save_failed:"))
    return `Saving failed (${code.slice("save_failed:".length)}). Try again.`;
  if (code.startsWith("move_failed:"))
    return `Moving your publication failed (${code.slice("move_failed:".length)}). Try again.`;
  return ERROR_MESSAGES[code] ?? "Something went wrong. Try again.";
}

const getSettings = createServerFn({ method: "GET" }).handler(async () => {
  const request = getRequest();
  const did = await readSessionDid(request, env.COOKIE_SECRET);
  if (!did) return null;
  const origin = new URL(request.url).origin;
  const handle = await resolveDidToHandle(did).catch(() => null);
  const ident = handle ?? did;

  // Read the writer's Goldroad-managed publication (same matching rule as the
  // write path: URL prefix on our origins, canonical + legacy — other apps'
  // publications are never shown here, and never overwritten).
  let name = "";
  let description = "";
  let exists = false;
  let publicationUrl = `${canonicalOrigin(origin)}/@${ident}`;
  let onLegacyUrl = false;
  try {
    const pds = await resolveDidToPds(did);
    const pubs = await listRecords<StandardPublication>(
      pds,
      did,
      "site.standard.publication",
      { reverse: true },
    );
    const own = pubs.find((p) =>
      isOwnPublicationUrl(p.value.url, ownOrigins(origin)),
    );
    if (own) {
      exists = true;
      name = typeof own.value.name === "string" ? own.value.name : "";
      description =
        typeof own.value.description === "string" ? own.value.description : "";
      if (typeof own.value.url === "string") publicationUrl = own.value.url;
      onLegacyUrl = isOwnPublicationUrl(own.value.url, LEGACY_ORIGINS);
    }
  } catch {
    // No publication yet, or the PDS is unreachable — the form starts fresh.
  }

  // Record counts for the "Your data" section — cheap enough to run on every
  // load. A flaked D1 read stays honest (null) rather than claiming "0".
  const dataCounts = await Promise.all([
    countDraftsForDid(drizzle(env.DB), did),
    countImportItemsForDid(drizzle(env.DB), did),
  ])
    .then(([drafts, importLedger]) => ({
      drafts: drafts.length,
      importLedger: importLedger.length,
    }))
    .catch(() => null);

  return {
    ident,
    exists,
    name,
    description,
    publicationUrl,
    onLegacyUrl,
    dataCounts,
  };
});

export const Route = createFileRoute("/settings")({
  validateSearch: (search: Record<string, unknown>) => {
    const out: { error?: string; saved?: boolean; moved?: boolean } = {};
    if (typeof search.error === "string") out.error = search.error;
    if (search.saved === "1" || search.saved === 1) out.saved = true;
    if (search.moved === "1" || search.moved === 1) out.moved = true;
    return out;
  },
  loader: async () => {
    const settings = await getSettings();
    if (!settings) throw redirect({ to: "/write" });
    return settings;
  },
  head: () => ({
    meta: [
      { title: "Publication settings — Goldroad" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: SettingsPage,
});

function SettingsPage() {
  const {
    ident,
    exists,
    name,
    description,
    publicationUrl,
    onLegacyUrl,
    dataCounts,
  } = Route.useLoaderData();
  const { error, saved, moved } = Route.useSearch();
  const message = errorMessage(error);

  return (
    <AppShell header={{ variant: "signed-in", ident, active: "settings" }}>
      <main className="mx-auto w-full max-w-2xl px-6 py-10">
        <h1 className="font-black font-display text-3xl text-ink tracking-tight">
          Your publication
        </h1>
        <p className="mt-2 max-w-[52ch] text-ink-soft">
          Your publication lives in your own data repo — you own it, and any app
          on the open network can read it. Posts you publish attach to it.
        </p>
        {saved && (
          <Notice>
            Saved to your repo.{" "}
            {/* New tab: the writer keeps their settings context. */}
            <ExternalLink
              className="underline underline-offset-2"
              href={`/@${encodeURIComponent(ident)}`}
            >
              See it on your public page
            </ExternalLink>
            .
          </Notice>
        )}
        {moved && (
          <Notice>
            Done — your publication now lives at trygoldroad.com. Old links
            redirect here.
          </Notice>
        )}
        {message && <Notice tone="alert">{message}</Notice>}
        {onLegacyUrl && !moved && <MovePublicationNotice returnTo="settings" />}
        <form
          action="/api/publish"
          className="mt-10 flex flex-col gap-8"
          method="post"
        >
          <input name="intent" type="hidden" value="publication" />
          <div className="flex flex-col gap-2">
            <label
              className="font-bold font-display text-ink text-sm"
              htmlFor="name"
            >
              Publication name
            </label>
            <p className="font-display text-ink-soft text-xs" id="name-help">
              The masthead of your public page — it also names the rich card
              when a post is shared on Bluesky.
            </p>
            <input
              aria-describedby="name-help"
              className="min-h-11 border border-ink bg-paper px-4 py-2.5 font-body text-base text-ink placeholder:text-ink-soft/60"
              defaultValue={name}
              id="name"
              maxLength={MAX_NAME_LENGTH}
              name="name"
              placeholder={ident}
              required
              type="text"
            />
          </div>
          <div className="flex flex-col gap-2">
            <label
              className="font-bold font-display text-ink text-sm"
              htmlFor="description"
            >
              Description
            </label>
            <p
              className="font-display text-ink-soft text-xs"
              id="description-help"
            >
              A line or two under your name — what readers can expect from you.
            </p>
            <textarea
              aria-describedby="description-help"
              className="min-h-28 border border-ink bg-paper px-4 py-3 font-body text-base text-ink leading-relaxed placeholder:text-ink-soft/60"
              defaultValue={description}
              id="description"
              maxLength={MAX_PUBLICATION_DESCRIPTION_LENGTH}
              name="description"
              placeholder="What do you write about?"
            />
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <button
              className="min-h-11 cursor-pointer bg-spot px-8 py-2.5 font-bold font-display text-base text-paper transition-colors hover:bg-ink"
              type="submit"
            >
              {exists ? "Save changes" : "Create publication"}
            </button>
            {/* New tab: leaving for the public page would drop unsaved edits. */}
            <ExternalLink
              className="-my-2 inline-flex min-h-11 items-center font-display text-ink-soft text-sm underline underline-offset-2 transition-colors hover:text-ink"
              href={`/@${encodeURIComponent(ident)}`}
            >
              View it live
            </ExternalLink>
          </div>
        </form>
        <dl className="mt-12 border-rule border-t pt-6">
          <dt className="font-bold font-display text-ink text-sm">
            Your public address
          </dt>
          <dd className="mt-1 font-display text-ink-soft text-sm">
            {/* May point at a legacy origin until the writer moves it. */}
            <ExternalLink
              className="underline underline-offset-2 transition-colors hover:text-ink"
              href={publicationUrl}
            >
              {publicationUrl}
            </ExternalLink>
            <span className="mt-1 block text-xs">
              Custom domains come later — your address moves with you, and old
              links keep working.
            </span>
          </dd>
        </dl>

        <section
          aria-labelledby="your-data-heading"
          className="mt-12 border-rule border-t pt-6"
        >
          <h2
            className="font-bold font-display text-ink text-lg"
            id="your-data-heading"
          >
            Your data
          </h2>
          <p className="mt-2 max-w-[56ch] text-ink-soft text-sm leading-relaxed">
            Goldroad stores remarkably little for your account: drafts, your
            import history, and your sign-in session — that's it. What you've
            published lives in your own atproto repo, not here, so nothing below
            touches it.
          </p>
          <p className="mt-3 font-display text-ink-soft text-sm">
            {dataCounts
              ? `${dataCounts.drafts} ${dataCounts.drafts === 1 ? "draft" : "drafts"} · ${dataCounts.importLedger} import ${dataCounts.importLedger === 1 ? "record" : "records"} stored with us.`
              : "Record counts couldn't be loaded right now — that's just this readout; export and deletion still work."}
          </p>
          <div className="mt-4">
            <ExportDataButton />
          </div>
          <div className="mt-8 border-rule border-t pt-6">
            <h3 className="font-bold font-display text-ink text-sm">
              Delete your account
            </h3>
            <p className="mt-2 max-w-[56ch] text-ink-soft text-sm leading-relaxed">
              Deletes your drafts, import history, and sign-in from our servers,
              permanently. Your published posts and any Bluesky announces stay
              exactly where they are — they're records in your own repo, not
              ours.
            </p>
            <div className="mt-4">
              <DeleteAccountForm ident={ident} />
            </div>
          </div>
        </section>
      </main>
    </AppShell>
  );
}

type DownloadState = "idle" | "working" | "error";

/**
 * Data-export download. A `fetch()` (not a plain `<a href>`): the endpoint is
 * session-authed POST, and the response needs to become a client-side blob
 * download rather than a browser-navigated page. Same fetch-then-invalidate
 * shape as the dashboard's draft delete.
 * Exported for tests (settings-account-rights.test.tsx) — not a route.
 */
export function ExportDataButton() {
  const [state, setState] = useState<DownloadState>("idle");

  async function download() {
    setState("working");
    try {
      const res = await fetch("/api/account/export", { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition") ?? "";
      const filename =
        /filename="([^"]+)"/.exec(disposition)?.[1] ?? "goldroad-data.json";
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      // appendChild, not append: Cloudflare's worker-configuration.d.ts
      // globally merges an HTMLRewriter `Element.append(string | ReadableStream
      // | Response)` overload into DOM's Element, which makes `.append(node)`
      // fail to typecheck here. appendChild isn't touched by that merge.
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setState("idle");
    } catch {
      setState("error");
    }
  }

  return (
    <>
      <button
        className="min-h-11 cursor-pointer border border-ink bg-paper px-6 py-2.5 font-bold font-display text-base text-ink transition-colors hover:bg-ink hover:text-paper disabled:cursor-not-allowed disabled:opacity-60"
        disabled={state === "working"}
        onClick={() => void download()}
        type="button"
      >
        {state === "working" ? "Preparing…" : "Download your data"}
      </button>
      {state === "error" && (
        <Notice tone="alert">
          That didn't go through — try again in a moment.
        </Notice>
      )}
    </>
  );
}

/**
 * Confirm-before-delete for the whole account — the highest-stakes
 * destructive action on this page, so it always gets the real dialog (no
 * plain window.confirm branch, unlike ~/routes/dashboard's post delete).
 * Consequence copy is explicit, and the public-page link doubles as proof
 * the writer's published work survives the click.
 * Exported for tests (settings-account-rights.test.tsx) — not a route.
 */
export function DeleteAccountForm({ ident }: { ident: string }) {
  const formRef = useRef<HTMLFormElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const approvedRef = useRef(false);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    if (approvedRef.current) return;
    event.preventDefault();
    dialogRef.current?.showModal();
    cancelRef.current?.focus();
  }

  return (
    <>
      <form
        action="/api/account/delete"
        method="post"
        onSubmit={handleSubmit}
        ref={formRef}
      >
        <button
          className="min-h-11 cursor-pointer border border-spot px-6 py-2.5 font-bold font-display text-base text-spot transition-colors hover:bg-spot hover:text-paper"
          type="submit"
        >
          Delete account
        </button>
      </form>
      <dialog
        aria-describedby="delete-account-desc"
        aria-labelledby="delete-account-title"
        className="m-auto w-full max-w-md border-2 border-ink bg-paper p-6 text-ink backdrop:bg-ink/50"
        ref={dialogRef}
        role="alertdialog"
      >
        <h2
          className="font-black font-display text-ink text-xl tracking-tight"
          id="delete-account-title"
        >
          Delete your Goldroad account?
        </h2>
        <p
          className="mt-3 text-ink-soft leading-relaxed"
          id="delete-account-desc"
        >
          This deletes your drafts, import history, and sign-in from our servers
          — it can't be undone. It does NOT delete anything you've published:
          those records live in your own repo and stay exactly where they are,
          and any posts announcing them on Bluesky stay up too.
        </p>
        <p className="mt-2 font-display text-sm">
          <ExternalLink
            className="underline underline-offset-2 transition-colors hover:text-spot"
            href={`/@${encodeURIComponent(ident)}`}
          >
            View your public page
          </ExternalLink>{" "}
          <span className="text-ink-soft">
            — it'll still be there after you delete your account.
          </span>
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-4">
          <button
            className="min-h-11 cursor-pointer bg-spot px-6 font-bold font-display text-base text-paper transition-colors hover:bg-ink"
            onClick={() => {
              approvedRef.current = true;
              dialogRef.current?.close();
              formRef.current?.requestSubmit();
              approvedRef.current = false;
            }}
            type="button"
          >
            Delete my account
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
    </>
  );
}
