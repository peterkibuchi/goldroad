import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { drizzle } from "drizzle-orm/d1";
import { useEffect, useRef, useState } from "react";

import { AppearanceControl } from "~/components/appearance-control";
import { ExternalLink } from "~/components/external-link";
import { MovePublicationNotice } from "~/components/move-publication-notice";
import { Notice } from "~/components/notice";
import { AppShell } from "~/components/site-chrome";
import { MAIN_CONTENT_ID } from "~/components/skip-link";
import { ThemeEditor } from "~/components/theme-editor";
import { announceDefaultFor, selectWriterPrefs } from "~/lib/announce-prefs";
import {
  listRecords,
  NotFoundError,
  resolveDidIdentity,
  type StandardPublication,
} from "~/lib/atproto";
import { blobImagePath, coverImageCid } from "~/lib/blob";
import { squareIconImage } from "~/lib/image";
import { readLiveSessionDid } from "~/lib/live-session";
import { canonicalOrigin, LEGACY_ORIGINS, ownOrigins } from "~/lib/origin";
import { capture } from "~/lib/posthog";
import {
  isOwnPublicationUrl,
  MAX_NAME_LENGTH,
  MAX_PUBLICATION_DESCRIPTION_LENGTH,
} from "~/lib/publish";
import { countDraftsForDid, countImportItemsForDid } from "~/lib/rights-store";
import { type BasicTheme, parseTheme } from "~/lib/theme";
import { env } from "cloudflare:workers";

const ERROR_MESSAGES: Record<string, string> = {
  missing_name: "Give your publication a name.",
  too_long: "That name or description is too long.",
  icon_type: "Icons can be a JPEG, PNG, WebP, AVIF, or GIF image.",
  icon_too_large:
    "That icon is too large even after shrinking — pick an image under 1 MB.",
  icon_scope:
    "Uploading images needs a permission your current sign-in doesn't include yet — sign out and sign in again to add it.",
  move_no_publication:
    "There's no publication to move yet — it's created when you publish your first post.",
  theme_no_publication:
    "Your colours are stored with your publication, and there isn't one yet — it's created when you publish your first post.",
  theme_invalid:
    "Those colours didn't come through. Pick them again and save — nothing was changed.",
  announce_prefs_failed:
    "That setting couldn't be saved just now, so nothing changed. Try again in a moment.",
  delete_account_failed:
    "Deleting your account didn't go through. Refresh the page and try again.",
  // Named ahead of the two prefix fallbacks below, which would otherwise print
  // the raw code at a writer. Nothing was written, and saying so is the point:
  // the reason we refused is that we couldn't tell what was already there.
  "save_failed:publication_unreadable":
    "We couldn't reach your publication just now, so nothing was changed. Refresh the page and try again.",
  "move_failed:publication_unreadable":
    "We couldn't reach your publication just now, so nothing was moved. Refresh the page and try again.",
};

function errorMessage(code: string | undefined): string | null {
  if (!code) return null;
  const named = ERROR_MESSAGES[code];
  if (named) return named;
  if (code.startsWith("save_failed:"))
    return `Saving failed (${code.slice("save_failed:".length)}). Try again.`;
  if (code.startsWith("move_failed:"))
    return `Moving your publication failed (${code.slice("move_failed:".length)}). Try again.`;
  return "Something went wrong. Try again.";
}

const getSettings = createServerFn({ method: "GET" }).handler(async () => {
  const request = getRequest();
  const did = await readLiveSessionDid(
    request,
    env.COOKIE_SECRET,
    drizzle(env.DB),
  );
  if (!did) return null;
  const origin = new URL(request.url).origin;
  const { handle, pds } = await resolveDidIdentity(did);
  const ident = handle ?? did;

  // Read the writer's Goldroad-managed publication (same matching rule as the
  // write path: URL prefix on our origins, canonical + legacy — other apps'
  // publications are never shown here, and never overwritten).
  let name = "";
  let description = "";
  let exists = false;
  let publicationUrl = `${canonicalOrigin(origin)}/@${ident}`;
  let onLegacyUrl = false;
  let iconPath: string | null = null;
  let theme: BasicTheme | null = null;
  /** We asked the PDS and it didn't answer — which is NOT the same as having no
   * publication, and the form below cannot be trusted either way. See the catch. */
  let unreadable = false;
  try {
    // No PDS is the same kind of "we couldn't read it" as a failed listRecords
    // — never an empty publication. See the catch.
    if (!pds) throw new NotFoundError(`no PDS resolved for ${did}`);
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
      // The icon has always been in the record; nothing here ever showed it.
      // Untrusted shape — coverImageCid validates the blob ref before we
      // mint a /img path from it.
      const iconCid = coverImageCid(own.value.icon);
      if (iconCid) iconPath = blobImagePath(did, iconCid);
      // The writer's own record is read back through the same door a
      // stranger's is: a theme another app wrote (or wrote badly) must not
      // reach the editor unvalidated.
      theme = parseTheme(own.value.basicTheme);
    }
  } catch (err) {
    // Deliberately NOT treated as "no publication yet". An empty form rendered
    // from a failed read is a trap: the writer types a name over what looks
    // like a blank slate, submits, and their existing description — which the
    // form posted as "" — is deleted from the record. So say we couldn't load
    // it, and don't offer to save it. (Same honesty as the D1 counts below.)
    console.warn("settings publication read failed", err);
    unreadable = true;
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

  // The announce default. An absent row means every default (~/lib/announce-prefs),
  // and a flaked read lands on the same answer — which is safe here in a way it
  // would not be on a publish path: this renders a checkbox the writer can see
  // and correct, and nothing is posted anywhere on the strength of it.
  const [prefs] = await selectWriterPrefs(drizzle(env.DB), did).catch(() => []);

  return {
    ident,
    exists,
    unreadable,
    name,
    description,
    iconPath,
    publicationUrl,
    onLegacyUrl,
    theme,
    dataCounts,
    announceDefault: announceDefaultFor(prefs),
  };
});

export const Route = createFileRoute("/settings")({
  validateSearch: (search: Record<string, unknown>) => {
    const out: {
      error?: string;
      saved?: boolean;
      moved?: boolean;
      kind?: "theme" | "announcing";
    } = {};
    if (typeof search.error === "string") out.error = search.error;
    if (search.saved === "1" || search.saved === 1) out.saved = true;
    if (search.moved === "1" || search.moved === 1) out.moved = true;
    // Which save it was, for two reasons now: adoption we cannot otherwise see
    // (theming), and a confirmation that would otherwise LIE. Every other save
    // on this page writes to the writer's repo and the notice says so; the
    // announce default is a row in our database, and telling a writer it went to
    // their repo would be false.
    if (search.kind === "theme" || search.kind === "announcing")
      out.kind = search.kind;
    return out;
  },
  loader: async () => {
    const settings = await getSettings();
    // Unauthed → /write, which renders the sign-in form, carrying this page as
    // the destination to come back to.
    if (!settings)
      throw redirect({ to: "/write", search: { returnTo: "/settings" } });
    return settings;
  },
  head: () => ({
    meta: [
      { title: "Settings — Goldroad" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: SettingsPage,
});

/**
 * One labelled band of the page — Pressroom register: display-type heading,
 * a hairline above it, air between bands. The bands are the page's structure:
 * a writer should be able to find "where do I change my icon" by scanning
 * headings, not by reading every field.
 * Exported for tests (settings-sections.test.tsx) — not a route.
 */
export function SettingsSection({
  children,
  id,
  intro,
  rule = "hair",
  title,
}: {
  children: React.ReactNode;
  id: string;
  intro?: string;
  /** The band's top separator: a hairline between ordinary bands, a full ink
   * rule before the destructive one (the separation is the warning), and none
   * for the first band under the page title. */
  rule?: "hair" | "heavy" | "none";
  title: string;
}) {
  const RULES = {
    hair: "mt-12 border-rule border-t pt-8",
    heavy: "mt-16 border-ink border-t-2 pt-8",
    none: "mt-8",
  } as const;
  return (
    <section aria-labelledby={`${id}-heading`} className={RULES[rule]}>
      <h2
        className="font-bold font-display text-ink text-lg tracking-tight"
        id={`${id}-heading`}
      >
        {title}
      </h2>
      {intro && (
        <p className="mt-2 text-pretty text-ink-soft text-sm leading-relaxed">
          {intro}
        </p>
      )}
      <div className="mt-6">{children}</div>
    </section>
  );
}

const FIELD_LABEL = "font-bold font-display text-ink text-sm";
const FIELD_HELP = "font-display text-ink-soft text-xs leading-relaxed";
const FIELD_INPUT =
  "border border-ink bg-paper px-4 py-2.5 font-body text-base text-ink placeholder:text-ink-soft/60";

/**
 * Publication-icon picker. The field has been in the record all along; this is
 * the first thing in the product to write it. Same mechanics as the cover
 * picker on /write: the pick is squared and shrunk in the browser (canvas →
 * JPEG ≤1MB, see ~/lib/image) and written back into the file input, so the
 * plain multipart submit carries the processed file and the server re-enforces
 * the caps regardless.
 * Exported for tests (settings-sections.test.tsx) — not a route.
 */
export function IconField({
  existingPath,
  onBusyChange,
}: {
  existingPath: string | null;
  onBusyChange: (busy: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(existingPath);
  const [removed, setRemoved] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function swapPreview(next: string | null) {
    setPreview((old) => {
      if (old?.startsWith("blob:")) URL.revokeObjectURL(old);
      return next;
    });
  }

  async function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    setPickError(null);
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      input.value = "";
      setPickError("That file isn't an image — try a JPEG or PNG.");
      return;
    }
    setBusy(true);
    onBusyChange(true);
    try {
      const processed = await squareIconImage(file);
      if (processed !== file) {
        const transfer = new DataTransfer();
        transfer.items.add(processed);
        input.files = transfer.files;
      }
      swapPreview(URL.createObjectURL(processed));
      setRemoved(false);
    } catch {
      input.value = "";
      setPickError("That image couldn't be read — try a JPEG or PNG.");
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }

  function handleRemove() {
    if (inputRef.current) inputRef.current.value = "";
    swapPreview(null);
    setRemoved(true);
    setPickError(null);
  }

  const linkClass =
    "inline-flex min-h-9 cursor-pointer items-center font-display text-ink-soft text-sm underline underline-offset-2 transition-colors hover:text-ink peer-focus-visible:outline-2 peer-focus-visible:outline-spot peer-focus-visible:outline-offset-2";

  return (
    <div className="flex flex-col gap-2">
      <span className={FIELD_LABEL} id="icon-label">
        Icon
      </span>
      <p className={FIELD_HELP} id="icon-help">
        A square image, at least 256×256. It appears on your public page and
        beside your name on every post.
      </p>
      {/* Two <label>s point at this input (the square and the text link), so
          the name comes from aria-labelledby instead: "Icon", not both labels
          concatenated. */}
      <input
        accept="image/jpeg,image/png,image/webp,image/avif,image/gif"
        aria-describedby="icon-help"
        aria-labelledby="icon-label"
        className="peer sr-only"
        id="icon"
        name="icon"
        onChange={handleChange}
        ref={inputRef}
        type="file"
      />
      {/* Removing an existing icon must be explicit on the wire — an empty
          file input alone means "keep what's there". */}
      {removed && existingPath && (
        <input name="removeIcon" type="hidden" value="1" />
      )}
      <div className="mt-1 flex items-center gap-4 peer-focus-visible:outline-2 peer-focus-visible:outline-spot peer-focus-visible:outline-offset-2">
        {preview ? (
          <img
            alt="Icon preview"
            className="size-16 shrink-0 border border-rule object-cover"
            src={preview}
          />
        ) : (
          <label
            className="flex size-16 shrink-0 cursor-pointer items-center justify-center border border-rule border-dashed font-display text-ink-soft text-xl transition-colors hover:border-ink hover:text-ink"
            htmlFor="icon"
          >
            +
          </label>
        )}
        <div className="flex flex-wrap items-center gap-x-5">
          <label className={linkClass} htmlFor="icon">
            {preview ? "Replace icon" : "Add an icon"}
          </label>
          {preview && (
            <button
              className={`${linkClass} hover:text-spot`}
              onClick={handleRemove}
              type="button"
            >
              Remove icon
            </button>
          )}
        </div>
      </div>
      <p aria-live="polite" className="sr-only" role="status">
        {busy ? "Preparing the icon…" : ""}
      </p>
      {pickError && (
        <p className="font-display text-sm text-spot" role="alert">
          {pickError}
        </p>
      )}
    </div>
  );
}

/**
 * The account-level announce switch.
 *
 * ONE CHECKBOX AND ONE SENTENCE, and the sentence is the whole design problem.
 * Announcing is on by default, so the only decision a writer makes here is to
 * turn it OFF — and they should be able to make that decision knowing what it
 * costs, before they press Save, not discover it a week later when a post
 * reached nobody. So the consequence is rendered the moment the box is unticked
 * and stays rendered while it is off.
 *
 * Its register is deliberate: ink-soft body text, not an alert, not the accent,
 * no icon. This is a fact about what happens, not a warning about a mistake —
 * publishing quietly is a legitimate thing to want, and a page that flinches
 * when you choose it is a page arguing with you.
 *
 * The checkbox is controlled so the sentence can follow it. Without JavaScript
 * the form still posts and still saves; the consequence line then simply appears
 * on the reload, which is the same words one moment later.
 *
 * Exported for tests (settings-announcing.test.tsx) — not a route.
 */
export function AnnounceSetting({ enabled }: { enabled: boolean }) {
  const [on, setOn] = useState(enabled);
  return (
    <form action="/api/publish" className="flex flex-col gap-4" method="post">
      <input name="intent" type="hidden" value="announce-prefs" />
      <div className="flex flex-col gap-2">
        <label className="flex min-h-9 cursor-pointer items-start gap-3 font-display text-ink text-sm">
          {/* accent-ink so the checked state is the page's own ink rather than
              the browser's blue — a control we didn't draw still carries the
              design (docs/DESIGN.md). */}
          <input
            aria-describedby="auto-announce-help"
            checked={on}
            className="mt-0.5 size-4 shrink-0 accent-ink"
            name="autoAnnounce"
            onChange={(event) => setOn(event.target.checked)}
            type="checkbox"
            value="1"
          />
          <span className="font-bold">Announce new posts on Bluesky</span>
        </label>
        <p className={FIELD_HELP} id="auto-announce-help">
          Applies to posts you publish and posts you schedule. You can turn it
          off for a single post on the publish screen — that never changes this
          setting.
        </p>
      </div>
      {/* aria-live, so a writer using a screen reader hears the consequence at
          the moment they choose it rather than only if they go looking. */}
      <p
        aria-live="polite"
        className="max-w-prose font-display text-ink-soft text-xs leading-relaxed"
      >
        {on
          ? ""
          : "Posts published without an announcement don't reach your followers' timelines and have no conversation on Bluesky. You can still announce any post by hand from your posts page, whenever you like."}
      </p>
      <div>
        <button
          className="min-h-11 cursor-pointer bg-ink px-8 py-2.5 font-bold font-display text-base text-paper transition-colors hover:bg-spot"
          type="submit"
        >
          Save announcing
        </button>
      </div>
    </form>
  );
}

function SettingsPage() {
  const {
    ident,
    exists,
    unreadable,
    name,
    description,
    iconPath,
    publicationUrl,
    onLegacyUrl,
    theme,
    dataCounts,
    announceDefault,
  } = Route.useLoaderData();
  const { error, saved, moved, kind } = Route.useSearch();
  const message = errorMessage(error);
  const [iconBusy, setIconBusy] = useState(false);

  // Theme adoption, captured where the save LANDS rather than where it was
  // submitted: the form posts to /api/publish and redirects, so the browser
  // that submitted it is gone by the time the write succeeds. Same pattern the
  // dashboard uses for post_published. Fires once per arrival with kind=theme,
  // never on a plain profile save.
  useEffect(() => {
    if (saved && kind === "theme") capture("theme_saved", { ident });
    // The number that matters for a default-on feature is how many writers turn
    // it OFF, and this is the only place that decision is visible. The value
    // comes from the loader, i.e. from the row the save just wrote.
    if (saved && kind === "announcing")
      capture("announce_default_changed", { ident, enabled: announceDefault });
  }, [saved, kind, ident, announceDefault]);

  return (
    <AppShell header={{ variant: "signed-in", ident, active: "settings" }}>
      <main
        className="mx-auto w-full max-w-2xl px-6 py-10"
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
      >
        <h1 className="font-black font-display text-3xl text-ink tracking-tight">
          Settings
        </h1>
        {/* Two confirmations, because there are two kinds of save on this page
            and one sentence cannot be true of both: the publication and its
            colours are records in the writer's repo, and the announce default is
            a row in ours that changes nothing anyone can go and look at. */}
        {saved && kind === "announcing" && (
          <Notice>
            Saved — it applies to the next post you publish or schedule.
          </Notice>
        )}
        {saved && kind !== "announcing" && (
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

        <SettingsSection
          id="publication"
          rule="none"
          intro="Your publication lives in your own data repo — you own it, and any app on the open network can read it. Posts you publish attach to it."
          title="Publication"
        >
          <form
            action="/api/publish"
            className="flex flex-col gap-8"
            encType="multipart/form-data"
            method="post"
          >
            <input name="intent" type="hidden" value="publication" />
            {/* The fields below are blank because the read failed, not because
                the writer has nothing — saving now would post those blanks. */}
            {unreadable && (
              <Notice tone="alert">
                We couldn't load your publication just now, so these fields may
                not show what's saved. Refresh the page before changing
                anything.
              </Notice>
            )}
            <IconField existingPath={iconPath} onBusyChange={setIconBusy} />
            <div className="flex flex-col gap-2">
              <label className={FIELD_LABEL} htmlFor="name">
                Name
              </label>
              <p className={FIELD_HELP} id="name-help">
                The masthead of your public page — it also names the rich card
                when a post is shared on Bluesky.
              </p>
              <input
                aria-describedby="name-help"
                className={`min-h-11 ${FIELD_INPUT}`}
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
              <label className={FIELD_LABEL} htmlFor="description">
                Description
              </label>
              <p className={FIELD_HELP} id="description-help">
                A line or two under your name — what readers can expect from
                you.
              </p>
              <textarea
                aria-describedby="description-help"
                className={`min-h-28 leading-relaxed ${FIELD_INPUT}`}
                defaultValue={description}
                id="description"
                maxLength={MAX_PUBLICATION_DESCRIPTION_LENGTH}
                name="description"
                placeholder="What do you write about?"
              />
            </div>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              {/* Ink, not spot. The rail's "New post" spends this surface's one
                  accent moment, and /settings is where that mattered most: it
                  showed four spot elements at once. The destructive band's
                  "Delete account" keeps the accent — a warning is the accent's
                  other meaning — so a save button can't also have it. */}
              <button
                className="min-h-11 cursor-pointer bg-ink px-8 py-2.5 font-bold font-display text-base text-paper transition-colors hover:bg-spot disabled:cursor-default disabled:opacity-40"
                disabled={iconBusy || unreadable}
                type="submit"
              >
                {/* Not "Create publication" when the read failed — we don't
                    know that there isn't one, and the server refuses anyway. */}
                {exists || unreadable ? "Save changes" : "Create publication"}
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
        </SettingsSection>

        <SettingsSection
          id="colours"
          intro="Four colours for your publication page and your posts. They're stored in your publication record on the open network, not in a Goldroad setting — so they come with you if you leave, and other apps that read the same records can use them too. Goldroad's own pages keep their own look."
          title="Colours"
        >
          {exists ? (
            <ThemeEditor
              disabled={unreadable}
              publicationName={name || ident}
              theme={theme}
            />
          ) : (
            <p className="font-display text-ink-soft text-sm">
              Your colours are stored with your publication — create one above,
              or publish your first post, and they'll appear here.
            </p>
          )}
        </SettingsSection>

        <SettingsSection id="address" title="Your public address">
          <p className="font-display text-ink-soft text-sm">
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
          </p>
        </SettingsSection>

        {/* Beside the public address rather than beside the colours: both bands
            answer "how do readers reach this", which is a different question
            from "what does it look like". */}
        <SettingsSection
          id="announcing"
          intro="A post you publish goes to your Bluesky followers as a card that links back to your page — the readers you already have, without a list to build first. Replies to that card become the conversation under your post."
          title="Announcing"
        >
          <AnnounceSetting enabled={announceDefault} />
        </SettingsSection>

        <SettingsSection id="appearance" title="Appearance">
          <AppearanceControl />
        </SettingsSection>

        <SettingsSection
          id="your-data"
          intro="Goldroad stores remarkably little for your account: drafts, your import history, your daily follower count, your announcing setting, and your sign-in session. That's everything keyed to your account. What you've published lives in your own data repo, not here, so nothing below touches it."
          title="Your data"
        >
          <p className="font-display text-ink-soft text-sm">
            {dataCounts
              ? `${dataCounts.drafts} ${dataCounts.drafts === 1 ? "draft" : "drafts"} · ${dataCounts.importLedger} import ${dataCounts.importLedger === 1 ? "record" : "records"} stored with us.`
              : "Record counts couldn't be loaded right now — that's just this readout; export and deletion still work."}
          </p>
          <div className="mt-4">
            <ExportDataButton />
          </div>
          {/* The one thing this page's export and the delete below genuinely
              can't reach. Said here and not only on /privacy, because this is
              the page where someone forms the belief that they've taken
              everything with them. */}
          <p className="mt-4 max-w-prose font-display text-ink-soft text-xs leading-relaxed">
            An email you gave our waitlist form, or left on an abuse report, is
            stored with no link to your account — we identify you by DID and
            never receive your email — so it's not in the export and account
            deletion doesn't remove it.{" "}
            <a
              className="underline underline-offset-2 transition-colors hover:text-ink"
              href="/privacy"
            >
              Privacy
            </a>{" "}
            says how to have it deleted by hand.
          </p>
        </SettingsSection>

        <SettingsSection
          id="delete-account"
          rule="heavy"
          intro="Deletes your drafts, import history, follower history, settings, and sign-in from our servers, permanently. Your published posts and any Bluesky announces stay exactly where they are — they're records in your own repo, not ours."
          title="Delete your account"
        >
          <DeleteAccountForm ident={ident} />
        </SettingsSection>
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
          This deletes your drafts, import history, follower history, and
          sign-in from our servers — it can't be undone. It does NOT delete
          anything you've published: those records live in your own repo and
          stay exactly where they are, and any posts announcing them on Bluesky
          stay up too.
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
