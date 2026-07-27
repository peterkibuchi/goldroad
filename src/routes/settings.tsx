import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

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
import { readSessionDid } from "~/lib/session";
import { env } from "cloudflare:workers";

const ERROR_MESSAGES: Record<string, string> = {
  missing_name: "Give your publication a name.",
  too_long: "That name or description is too long.",
  move_no_publication:
    "There's no publication to move yet — it's created when you publish your first post.",
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

  return { ident, exists, name, description, publicationUrl, onLegacyUrl };
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
  const { ident, exists, name, description, publicationUrl, onLegacyUrl } =
    Route.useLoaderData();
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
      </main>
    </AppShell>
  );
}
