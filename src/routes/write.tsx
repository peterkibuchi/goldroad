import { ClientOnly, createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { drizzle } from "drizzle-orm/d1";
import { lazy, Suspense, useEffect, useRef, useState } from "react";

import type { BlockNoteEditor } from "~/components/editor";
import { ExternalLink } from "~/components/external-link";
import { Notice } from "~/components/notice";
import { ScheduledTime } from "~/components/scheduled-time";
import { AppShell } from "~/components/site-chrome";
import {
  getRecord,
  resolveDidToHandle,
  resolveDidToPds,
  type StandardDocument,
} from "~/lib/atproto";
import { blobImagePath, coverImageCid } from "~/lib/blob";
import { selectDraft } from "~/lib/drafts";
import { isDraftId, MAX_DRAFTS_PER_USER } from "~/lib/drafts-schema";
import { downscaleImage } from "~/lib/image";
import { selectImportItemByDraft, selectMirror } from "~/lib/import-store";
import {
  countRemoteImages,
  createInlineImageStore,
  hasProxiedImages,
  imagesMissingAltText,
} from "~/lib/inline-images";
import { readLiveSessionDid } from "~/lib/live-session";
import {
  MAX_DEK_LENGTH,
  RECOMMENDED_DEK_LENGTH,
  TID_RE,
  writerDek,
} from "~/lib/publish";
import {
  utcMsToLocalInput,
  zoneOffsetForLocalInput,
} from "~/lib/schedule-time";
import { selectPendingScheduleForDraft } from "~/lib/scheduled-posts";
import { env } from "cloudflare:workers";

// BlockNote is client-only (ProseMirror needs a real DOM): lazy + ClientOnly
// keeps it out of SSR and out of the worker's hot path entirely.
const Editor = lazy(() => import("~/components/editor"));

const ERROR_MESSAGES: Record<string, string> = {
  schedule_no_draft:
    "That draft couldn't be found, so nothing was scheduled — reload this page and try again.",
  schedule_invalid: "Pick a date and time to schedule this post for.",
  schedule_past:
    "That time has already passed. Pick a time in the future — or just press Publish.",
  schedule_too_far:
    "Scheduling reaches about a year ahead. Pick a nearer date.",
  schedule_failed:
    "Scheduling didn't save just now. Your draft is safe — try again.",
  schedule_save_failed:
    "Your draft couldn't be saved, so it wasn't scheduled — a scheduled post publishes what was last saved, and that has to be what you see here. Try again.",
  unschedule_failed:
    "That schedule couldn't be cancelled just now. Try again from your posts page.",
  invalid_handle:
    "That doesn't look like a Bluesky handle — it's usually name.bsky.social, or your own domain. Check for typos and try again.",
  handle_not_found:
    "We couldn't find that handle on the network — check the spelling and try again, or wait a moment if its server is having trouble.",
  signin_unavailable:
    "Sign-in hit a server problem on our side — try again in a minute.",
  signin_failed: "Sign-in didn't complete. Try again.",
  session_expired: "Your session expired — sign in again.",
  missing_title: "Give it a title before publishing.",
  too_long: "That draft is too long for a single post right now.",
  not_found: "That post couldn't be loaded, so you're starting a new one.",
  not_editable:
    "That post was written in another app with a rich content format Goldroad can't edit yet — edit it where it was written.",
  cover_type: "Covers can be a JPEG, PNG, WebP, AVIF, or GIF image.",
  cover_too_large:
    "That cover is too large even after shrinking — pick an image under 1 MB.",
  cover_scope:
    "Uploading images needs a permission your current sign-in doesn't include yet — re-connect your account to add covers.",
  draft_not_found:
    "That draft isn't in your drafts anymore — you're starting a fresh one.",
  draft_load_failed:
    "That draft couldn't be loaded right now — it's still saved. Refresh to try again.",
};

function errorMessage(code: string | undefined): string | null {
  if (!code) return null;
  if (code.startsWith("publish_failed:"))
    return `Publishing failed (${code.slice("publish_failed:".length)}). Try again.`;
  return ERROR_MESSAGES[code] ?? "Something went wrong. Try again.";
}

type Draft = {
  rkey: string;
  title: string;
  /** The writer's own subtitle, or "" when the record's description is just
   * the generated body excerpt (see writerDek). */
  dek: string;
  textContent: string;
  /** Same-origin /img path for the existing cover, when the record has one. */
  coverPath: string | null;
  /** Set when this published post is a mirror (imported; original elsewhere):
   * the edit form then offers "make this the Goldroad original". */
  mirror: { sourceUrl: string | null } | null;
};

/** A pending schedule on the draft being resumed. `dueAt` is an ISO string —
 * loader data must serialize identically on both sides — and it is UTC, like
 * every stored schedule; the writer's own zone is applied in the browser. */
type PendingSchedule = { id: string; dueAt: string };

/** A saved (unpublished) draft being resumed from our D1 — distinct from
 * `Draft`, which is a published record being edited. */
type ResumedDraft = {
  id: string;
  title: string;
  dek: string;
  /** Set when this draft is already queued to publish. */
  schedule: PendingSchedule | null;
  /** The stored BlockNote JSON, verbatim (loader data must be plainly
   * serializable); the client parses it and falls back to an empty editor
   * when it's unreadable. */
  blocksJson: string;
  /** This draft came in through a feed/archive import, so publishing it will
   * copy its remote body images into the writer's own repo. */
  imported: boolean;
};

const getWriteContext = createServerFn({ method: "GET" })
  .validator((data: { edit?: string; draft?: string }) => ({
    edit:
      typeof data.edit === "string" && TID_RE.test(data.edit)
        ? data.edit
        : undefined,
    draft:
      typeof data.draft === "string" && isDraftId(data.draft)
        ? data.draft
        : undefined,
  }))
  .handler(async ({ data }) => {
    const did = await readLiveSessionDid(
      getRequest(),
      env.COOKIE_SECRET,
      drizzle(env.DB),
    );
    if (!did)
      return {
        viewer: null,
        draft: null,
        resumed: null,
        draftError: undefined,
      } as const;
    const handle = await resolveDidToHandle(did).catch(() => null);

    // Resume a saved draft (ownership enforced in the query's WHERE). Editing
    // a published record wins if both params are somehow present.
    let resumed: ResumedDraft | null = null;
    let draftError:
      | "not_found"
      | "not_editable"
      | "draft_not_found"
      | "draft_load_failed"
      | undefined;
    if (data.draft && !data.edit) {
      try {
        const [row] = await selectDraft(drizzle(env.DB), did, data.draft);
        if (row) {
          // Two best-effort side reads, in one batch — neither blocks the
          // other, and neither may cost the writer their draft:
          //   • the import ledger row, which tells them BEFORE they publish
          //     that publishing spends their repo quota on the post's images;
          //   • the pending schedule, if this draft is already queued.
          // A flaked read costs its own notice and nothing else. Ownership is
          // in both queries.
          const [[importRow], [pending]] = await Promise.all([
            selectImportItemByDraft(drizzle(env.DB), did, row.id).catch(
              () => [],
            ),
            selectPendingScheduleForDraft(
              drizzle(env.DB),
              did,
              data.draft,
            ).catch(() => []),
          ]);
          resumed = {
            id: row.id,
            title: row.title,
            dek: row.dek,
            blocksJson: row.content,
            imported: importRow !== undefined,
            schedule: pending
              ? { id: pending.id, dueAt: pending.dueAt.toISOString() }
              : null,
          };
        } else {
          draftError = "draft_not_found";
        }
      } catch {
        // A flaked read is NOT a missing draft: say so honestly — telling the
        // writer it's gone would invite retyping (and forking) their work.
        draftError = "draft_load_failed";
      }
    }

    let draft: Draft | null = null;
    if (data.edit) {
      try {
        const pds = await resolveDidToPds(did);
        const doc = await getRecord<StandardDocument>(
          pds,
          did,
          "site.standard.document",
          data.edit,
        );
        // Rich content unions (e.g. Leaflet's) are the source of truth in
        // their app — editing only textContent would silently fork the post.
        if (doc.content != null) draftError = "not_editable";
        else {
          const coverCid = coverImageCid(doc.coverImage);
          // Mirror lookup (import ledger): editing a mirrored post offers
          // adoption. Best-effort — a flaked read just hides the offer.
          const [mirror] = await selectMirror(
            drizzle(env.DB),
            did,
            data.edit,
          ).catch(() => []);
          draft = {
            rkey: data.edit,
            title: doc.title ?? "",
            dek: writerDek(doc),
            textContent: doc.textContent ?? "",
            coverPath: coverCid ? blobImagePath(did, coverCid) : null,
            mirror: mirror ? { sourceUrl: mirror.sourceUrl } : null,
          };
        }
      } catch {
        draftError = "not_found";
      }
    }
    return { viewer: { did, handle }, draft, resumed, draftError } as const;
  });

export const Route = createFileRoute("/write")({
  validateSearch: (search: Record<string, unknown>) => {
    const out: {
      error?: string;
      unscheduled?: boolean;
      edit?: string;
      draft?: string;
      handle?: string;
      returnTo?: string;
    } = {};
    if (typeof search.error === "string") out.error = search.error;
    // Set by a cancelled schedule (the unschedule intent redirects back here
    // with the draft still loaded) so the editor can confirm it in words.
    if (search.unscheduled === "1" || search.unscheduled === 1)
      out.unscheduled = true;
    if (typeof search.edit === "string") out.edit = search.edit;
    if (typeof search.draft === "string" && isDraftId(search.draft))
      out.draft = search.draft;
    // /login sends the entered handle back so the sign-in form can prefill it.
    if (typeof search.handle === "string") out.handle = search.handle;
    // Signed-in surfaces bounce anonymous arrivals to this page — the app's one
    // sign-in form — and name where the writer was actually headed. Taken
    // verbatim on purpose: `safeReturnTo` in `~/lib/oauth` is the single
    // open-redirect guard and it runs on the POST to /login, the only place
    // this value can ever become a `Location`. A second copy of that check
    // here would be a security rule with two homes, free to drift, in a module
    // whose transitive imports have no business in the client bundle.
    if (typeof search.returnTo === "string") out.returnTo = search.returnTo;
    return out;
  },
  loaderDeps: ({ search }) => ({ edit: search.edit, draft: search.draft }),
  loader: ({ deps }) =>
    getWriteContext({ data: { edit: deps.edit, draft: deps.draft } }),
  head: () => ({
    meta: [
      { title: "Write — Goldroad" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: WritePage,
});

function ErrorNotice({ code }: { code: string | undefined }) {
  const message = errorMessage(code);
  if (!message) return null;
  return (
    <p
      className="mb-6 border border-spot px-4 py-3 font-display text-sm text-spot"
      role="alert"
    >
      {message}
    </p>
  );
}

/** Exported for tests (write-signin.test.tsx) — not a route. */
export function SignIn({
  error,
  handle,
  returnTo = "/write",
}: {
  error: string | undefined;
  /** What the writer entered on a failed attempt — prefilled for correction. */
  handle: string | undefined;
  /**
   * Where the writer was headed. Defaults to the editor, because a writer who
   * came to /write on purpose asked to write; the surfaces that bounce their
   * anonymous visitors here pass their own path instead, so signing in returns
   * them to what they clicked rather than to whichever page hosts the form.
   */
  returnTo?: string;
}) {
  const message = errorMessage(error);
  return (
    <main className="mx-auto w-full max-w-md px-6 py-16 md:py-24">
      <h1 className="font-black font-display text-3xl text-ink tracking-tight">
        Sign in to write
      </h1>
      <p className="mt-3 font-body text-ink-soft leading-relaxed">
        Goldroad publishes from your own account — sign in with your Bluesky (or
        any atproto) handle.
      </p>
      {message && <Notice tone="alert">{message}</Notice>}
      <form
        action="/login"
        className="mt-8 flex flex-col gap-3 border-2 border-ink p-6"
        method="post"
      >
        <label
          className="font-bold font-display text-ink text-sm"
          htmlFor="handle"
        >
          Your handle
        </label>
        <input
          autoComplete="username"
          className="min-h-11 border border-ink bg-paper px-4 py-2.5 font-body text-base text-ink placeholder:text-ink-soft"
          defaultValue={handle ?? ""}
          id="handle"
          name="handle"
          placeholder="you.bsky.social"
          required
          type="text"
        />
        <input name="returnTo" type="hidden" value={returnTo} />
        <button
          className="min-h-11 cursor-pointer bg-spot px-6 py-2.5 font-bold font-display text-base text-paper transition-colors hover:bg-ink"
          type="submit"
        >
          Continue
        </button>
        <p className="mt-1 font-display text-ink-soft text-xs leading-relaxed">
          Goldroad never sees your password — you approve access on your own
          server, and you can revoke it there anytime.
        </p>
      </form>
      <p className="mt-6 font-display text-ink-soft text-sm">
        New to Bluesky?{" "}
        <ExternalLink
          className="underline underline-offset-2 transition-colors hover:text-ink"
          href="https://bsky.app"
        >
          Create a free account
        </ExternalLink>{" "}
        — it's the account you'll sign in and publish with here.
      </p>
    </main>
  );
}

/** Loading policy: skeleton bars, never spinners (see ~/components/system-pages). */
function EditorFallback() {
  return (
    <div aria-label="Loading the editor" aria-live="polite" role="status">
      <div className="min-h-96 animate-pulse space-y-3 px-1 py-3 motion-reduce:animate-none">
        <div className="h-4 w-full bg-rule/50" />
        <div className="h-4 w-11/12 bg-rule/50" />
        <div className="h-4 w-3/5 bg-rule/50" />
      </div>
      <p className="sr-only">Loading the editor…</p>
    </div>
  );
}

/**
 * Cover-image picker — calm register. The picked file is downscaled in the
 * browser (canvas → JPEG ≤1MB, see ~/lib/image) and written back into the
 * file input via DataTransfer, so the plain multipart form submit carries
 * the processed file; the server re-enforces the caps regardless.
 *
 * With no cover yet it draws an empty slot exactly where the cover will sit,
 * so the control teaches by position instead of by label alone — and gives
 * the whole strip as a touch target rather than one line of link text.
 */
function CoverPicker({
  existingPath,
  onBusyChange,
}: {
  existingPath: string | null;
  onBusyChange: (busy: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(existingPath);
  const [removed, setRemoved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);

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
      const processed = await downscaleImage(file);
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
    <div className="mb-8">
      <input
        accept="image/jpeg,image/png,image/webp,image/avif,image/gif"
        className="peer sr-only"
        id="cover"
        name="cover"
        onChange={handleChange}
        ref={inputRef}
        type="file"
      />
      {/* Removing an existing cover must be explicit on the wire — an empty
          file input alone means "keep what's there". */}
      {removed && existingPath && (
        <input name="removeCover" type="hidden" value="1" />
      )}
      {preview ? (
        // Direct sibling of the input: keyboard focus on the (visually
        // hidden) file input outlines the whole preview block.
        <div className="peer-focus-visible:outline-2 peer-focus-visible:outline-spot peer-focus-visible:outline-offset-2">
          <img
            alt="Cover preview"
            className="aspect-video w-full bg-ink/5 object-cover"
            src={preview}
          />
          <div className="mt-2 flex flex-wrap items-center gap-x-5">
            <label className={linkClass} htmlFor="cover">
              Replace cover
            </label>
            <button
              className={`${linkClass} hover:text-spot`}
              onClick={handleRemove}
              type="button"
            >
              Remove cover
            </button>
          </div>
        </div>
      ) : (
        <label
          className="flex min-h-11 w-full cursor-pointer flex-wrap items-center justify-center gap-x-2 border border-rule border-dashed px-4 py-2 text-center font-display text-ink-soft text-sm transition-colors hover:border-ink hover:text-ink peer-focus-visible:outline-2 peer-focus-visible:outline-spot peer-focus-visible:outline-offset-2"
          htmlFor="cover"
        >
          Add a cover image
          <span className="hidden text-xs sm:inline">
            · heads your post, and the card when it's shared
          </span>
        </label>
      )}
      <p aria-live="polite" className="sr-only" role="status">
        {busy ? "Preparing the cover image…" : ""}
      </p>
      {pickError && (
        <p className="mt-1 font-display text-sm text-spot" role="alert">
          {pickError}
        </p>
      )}
    </div>
  );
}

const AUTOSAVE_DEBOUNCE_MS = 3000;

type SaveState = "idle" | "saving" | "saved" | "error" | "limit";

const SAVE_INDICATOR_TEXT: Record<SaveState, string> = {
  idle: "",
  saving: "Saving…",
  saved: "Draft saved",
  error: "Couldn't save — retrying as you write",
  limit: `You have ${MAX_DRAFTS_PER_USER} drafts — delete one from your posts page to keep autosaving`,
};

/**
 * Autosave status in the calm register: text only, no spinners. It sits at the
 * top of the page, where a writer's eye already is, and keeps its line even
 * when it has nothing to say (`min-h-4`) so nothing below it ever jumps as the
 * text changes. The live region announces transitions politely.
 * Exported for tests — not a route.
 */
export function SaveIndicator({ state }: { state: SaveState }) {
  return (
    <p
      aria-live="polite"
      className="mb-2 min-h-4 text-right font-display text-ink-soft text-xs leading-4"
      role="status"
    >
      {SAVE_INDICATOR_TEXT[state]}
    </p>
  );
}

/**
 * The subtitle (dek) — its own field between title and body, written to the
 * record's `description`, which is what a reader sees under the title, what
 * the archive row shows, and what rides along on a shared card.
 *
 * Own component, own state: the length note re-renders on every keystroke,
 * and Compose (which holds the editor) must not. The cap is the lexicon's,
 * not our taste — past the recommended length the note says what actually
 * happens rather than refusing the words.
 */
function SubtitleField({
  defaultValue,
  fieldRef,
  onChange,
}: {
  defaultValue: string;
  fieldRef: React.RefObject<HTMLTextAreaElement | null>;
  onChange: () => void;
}) {
  const [length, setLength] = useState(defaultValue.length);
  const long = length > RECOMMENDED_DEK_LENGTH;

  return (
    <>
      <label className="sr-only" htmlFor="dek">
        Subtitle
      </label>
      <textarea
        aria-describedby="dek-help"
        className="field-sizing-content mt-4 w-full resize-none overflow-hidden rounded-none border-0 border-transparent border-b-2 bg-paper px-1 py-1 font-body text-ink-soft text-xl italic leading-relaxed placeholder:text-ink-soft/50 focus-visible:border-spot focus-visible:outline-none"
        defaultValue={defaultValue}
        id="dek"
        maxLength={MAX_DEK_LENGTH}
        name="dek"
        onChange={(event) => {
          setLength(event.currentTarget.value.length);
          onChange();
        }}
        placeholder="Add a subtitle"
        ref={fieldRef}
        rows={1}
      />
      <p
        className="mt-2 px-1 font-display text-ink-soft text-xs leading-relaxed"
        id="dek-help"
      >
        {long
          ? `${length} characters — past about ${RECOMMENDED_DEK_LENGTH}, shared cards and archive rows trim it.`
          : "Optional — a sentence or two, shown under your title and on shared cards."}
      </p>
    </>
  );
}

/**
 * Scheduling, on the publish flow — a time and two buttons, next to the button
 * it is an alternative to.
 *
 * ITS OWN FORM, not a second submit button on the publish form. The publish form
 * is multipart and carries the cover file and the whole body; scheduling needs
 * neither (the draft is the payload — see the schedule intent in
 * ~/routes/api.publish), and submitting it through that form would upload a
 * megabyte of cover image to save a due date.
 *
 * `prepare` is what makes this safe: it flushes the draft — blocks AND the
 * markdown projection — and hands back the draft id, so what publishes on
 * Tuesday is what was on screen when the writer pressed Schedule. A save that
 * fails schedules nothing and says so, because the alternative is a post
 * quietly going out with older words in it.
 *
 * Exported for tests (write-schedule.test.tsx) — not a route.
 */
export function SchedulePanel({
  existing,
  draftId,
  prepare,
  disabled,
}: {
  existing: PendingSchedule | null;
  /** The draft this panel is scheduling, when it has been saved once — what a
   * cancel needs in order to return the writer to THIS draft rather than to a
   * blank editor. Null for a composition that has never been saved, which
   * cannot have a schedule to cancel either. */
  draftId: string | null;
  /** Flush the draft; resolves to its id, or null if the save failed. */
  prepare: () => Promise<string | null>;
  disabled?: boolean;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const draftIdRef = useRef<HTMLInputElement>(null);
  const offsetRef = useRef<HTMLInputElement>(null);
  const localRef = useRef<HTMLInputElement>(null);
  const [localValue, setLocalValue] = useState("");
  const [min, setMin] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Both of these are the browser's knowledge, not the server's, so they arrive
  // after mount rather than risking a hydration mismatch: the existing
  // schedule read back into the writer's own clock, and "now" as the earliest
  // selectable minute.
  useEffect(() => {
    const now = new Date();
    setMin(
      utcMsToLocalInput(now.getTime(), now.getTimezoneOffset()) ?? undefined,
    );
  }, []);
  useEffect(() => {
    if (!existing) return;
    const ms = Date.parse(existing.dueAt);
    if (Number.isNaN(ms)) return;
    const value = utcMsToLocalInput(ms, new Date(ms).getTimezoneOffset());
    if (value) setLocalValue(value);
  }, [existing]);

  async function handleSchedule() {
    setError(null);
    const local = localValue.trim();
    const offset = local ? zoneOffsetForLocalInput(local) : null;
    if (!local || offset === null) {
      setError(ERROR_MESSAGES.schedule_invalid);
      localRef.current?.focus();
      return;
    }
    setBusy(true);
    let draftId: string | null = null;
    try {
      draftId = await prepare();
    } catch (err) {
      // A save can throw as well as fail (exporting the markdown is the
      // editor's work, not ours) — either way the button has to come back and
      // the writer has to be told, rather than left pressing a dead control.
      console.warn("draft save before scheduling threw", err);
    } finally {
      setBusy(false);
    }
    if (!draftId) {
      setError(ERROR_MESSAGES.schedule_save_failed);
      return;
    }
    if (draftIdRef.current) draftIdRef.current.value = draftId;
    if (offsetRef.current) offsetRef.current.value = String(offset);
    formRef.current?.requestSubmit();
  }

  const zoneNote = existing
    ? null
    : "Publishes at the time you pick — Goldroad checks for due posts every hour, so it goes out within the hour after it. Times are in your own time zone.";

  return (
    <div className="mt-6 border-rule border-t pt-6">
      {existing && (
        <p className="font-display text-ink text-sm leading-relaxed">
          <span className="font-bold">Scheduled</span> for{" "}
          <ScheduledTime iso={existing.dueAt} />. You can keep editing — this
          publishes whatever is saved when it goes out.
        </p>
      )}
      <form action="/api/publish" className="mt-2" method="post" ref={formRef}>
        <input name="intent" type="hidden" value="schedule" />
        <input name="draftId" ref={draftIdRef} type="hidden" />
        {/* Filled at submit time with the offset in effect AT THE CHOSEN
            MOMENT, which is what makes a schedule across a DST change land on
            the hour the writer meant (~/lib/schedule-time). */}
        <input name="dueTzOffset" ref={offsetRef} type="hidden" />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <label
            className="font-display text-ink-soft text-sm"
            htmlFor="dueAtLocal"
          >
            {existing ? "Change the time" : "Schedule for later"}
          </label>
          {/* 16px at base, 14px from `sm:` up: iOS Safari zooms the page in on
              a focused control under 16px and never zooms back out — and this
              one opens a date picker, so the zoom lands mid-decision. */}
          <input
            className="min-h-11 border border-rule bg-paper px-3 font-display text-base text-ink focus-visible:border-spot focus-visible:outline-none sm:text-sm"
            id="dueAtLocal"
            min={min}
            name="dueAtLocal"
            onChange={(event) => setLocalValue(event.target.value)}
            ref={localRef}
            type="datetime-local"
            value={localValue}
          />
          <button
            className="min-h-11 cursor-pointer border-2 border-ink px-5 font-bold font-display text-ink text-sm transition-colors hover:bg-ink hover:text-paper disabled:cursor-default disabled:opacity-40"
            disabled={disabled || busy}
            onClick={() => void handleSchedule()}
            type="button"
          >
            {existing ? "Reschedule" : "Schedule"}
          </button>
        </div>
      </form>
      {existing && (
        <form action="/api/publish" className="mt-2" method="post">
          <input name="intent" type="hidden" value="unschedule" />
          <input name="id" type="hidden" value={existing.id} />
          <input name="returnTo" type="hidden" value="write" />
          {/* The DRAFT's id, not the schedule row's: it is what sends the
              writer back to the piece they were editing. */}
          <input name="draftId" type="hidden" value={draftId ?? ""} />
          <button
            className="-my-2 inline-flex min-h-9 cursor-pointer items-center font-display text-ink-soft text-sm underline underline-offset-2 transition-colors hover:text-spot"
            type="submit"
          >
            Cancel the schedule
          </button>
        </form>
      )}
      <p
        aria-live="polite"
        className="mt-2 font-display text-ink-soft text-xs leading-relaxed"
      >
        {busy ? "Saving your draft…" : zoneNote}
      </p>
      {/* Stated where the decision is made, not discovered afterwards. */}
      <p className="mt-1 font-display text-ink-soft text-xs leading-relaxed">
        A scheduled post publishes its words, not a cover image — add a cover by
        editing the post once it's out, or press Publish instead.
      </p>
      {error && (
        <p className="mt-2 font-display text-sm text-spot" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** A fresh editor is a single empty paragraph — never mint a draft row for
 * an untouched page. */
function isBlankDocument(blocks: BlockNoteEditor["document"]): boolean {
  return blocks.every(
    (block) =>
      block.type === "paragraph" &&
      Array.isArray(block.content) &&
      block.content.length === 0 &&
      block.children.length === 0,
  );
}

/** Stored draft JSON → blocks array, or undefined when empty/unreadable (the
 * editor then starts empty rather than crashing the resume). */
function parseDraftBlocks(
  blocksJson: string | undefined,
): unknown[] | undefined {
  if (!blocksJson) return undefined;
  try {
    const parsed: unknown = JSON.parse(blocksJson);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function postDraft(payload: {
  id?: string;
  title: string;
  dek: string;
  content: unknown;
  /** The markdown projection of `content` — the same string publishing sends to
   * the record. Saved with the blocks (never separately) because it is what a
   * scheduled publish reads hours from now, and only the editor can produce
   * it: see `markdown` in ~/db/schema. */
  markdown: string;
  /** The body images' blob references, when THIS session uploaded any. Omitted
   * otherwise, which leaves whatever is stored intact — the store is per-mount,
   * so a resumed session has an empty one and must not blank the references a
   * scheduled publish will need. */
  inlineImages?: string;
}): Promise<Response> {
  const body = JSON.stringify(payload);
  return fetch("/api/drafts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    // keepalive lets a blur-flushed save survive page teardown (clicking a
    // nav link right after typing). The spec caps keepalive bodies (~64 KB
    // of ENCODED BYTES — string length would under-measure CJK/emoji text
    // and get the whole fetch rejected), so large drafts fall back to a
    // normal fetch rather than failing.
    keepalive: new TextEncoder().encode(body).byteLength < 60_000,
  });
}

/** Exported for tests (write-editor-submit.test.tsx) — not a route. */
export function Compose({
  draft,
  resumed,
  error,
  unscheduled,
  reconnectHandle,
}: {
  draft: Draft | null;
  resumed: ResumedDraft | null;
  error: string | undefined;
  /** A schedule was just cancelled — confirmed in words, not by absence. */
  unscheduled?: boolean;
  /** Handle for the one-click re-connect form on scope errors. */
  reconnectHandle: string | null;
}) {
  const [editor, setEditor] = useState<BlockNoteEditor | null>(null);
  const [coverBusy, setCoverBusy] = useState(false);
  // Body images uploaded during this session. One store per mount: the editor
  // fills it, the publish form submits it (the record must reference every
  // blob it uses — see ~/lib/inline-images).
  const [imageStore] = useState(createInlineImageStore);
  // Re-rendered only when the count actually changes, so counting on every
  // keystroke costs nothing (React bails out on an identical value).
  const [missingAlt, setMissingAlt] = useState(0);
  // Images still on the source's servers — what an imported post's publish
  // will copy into the writer's repo.
  const [remoteImages, setRemoteImages] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>(
    resumed ? "saved" : "idle",
  );
  // Parsed once per mount (Compose is keyed by the resume target).
  const [initialBlocks] = useState<unknown[] | undefined>(() =>
    parseDraftBlocks(resumed?.blocksJson),
  );
  const resumedHasImages = hasProxiedImages(initialBlocks ?? []);
  const bodyRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const dekRef = useRef<HTMLTextAreaElement>(null);
  const draftIdInputRef = useRef<HTMLInputElement>(null);
  const imagesInputRef = useRef<HTMLInputElement>(null);
  const editing = draft !== null;
  /** Display host for the mirror-adoption notice ("writer.substack.com"). */
  let mirrorHost: string | null = null;
  if (draft?.mirror?.sourceUrl) {
    try {
      mirrorHost = new URL(draft.mirror.sourceUrl).hostname;
    } catch {
      mirrorHost = null;
    }
  }

  // ---- Autosave (new compositions only). Editing a published post never
  // autosaves: the record in the writer's repo is the source of truth there,
  // and shadow-copying edits into the drafts table would fork it.
  const draftIdRef = useRef<string | null>(resumed?.id ?? null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const saveInFlightRef = useRef<Promise<string | null> | null>(null);
  /** The document differs from what is persisted — which is a *different*
   * question from whether autosave is pending. Editing a published post never
   * autosaves, so nothing ever clears this flag there and the leave-page
   * confirmation is the writer's only safety net. */
  const dirtyRef = useRef(false);
  const publishingRef = useRef(false);
  // Loading resumed blocks fires the editor's onChange before onReady —
  // ignore changes until the editor is ready so hydration never "saves".
  const readyRef = useRef(false);

  useEffect(() => () => imageStore.dispose(), [imageStore]);

  // Unsaved changes get the browser's leave-page confirmation. Registered on
  // both surfaces, and most important on the one that has no autosave behind
  // it: an edit of a published post is held nowhere but this tab, so a stray
  // click on a rail link (they are full-page navigations) is unrecoverable.
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current && !publishingRef.current) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  function handleEditorReady(instance: BlockNoteEditor) {
    readyRef.current = true;
    setEditor(instance);
  }

  function clearSaveTimer() {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  /**
   * Saves, and resolves to the draft's id — or null when nothing was saved.
   *
   * `force` ignores the dirty flag, which the scheduling flow needs: a writer
   * can resume a draft, change nothing, and schedule it, and the stored row
   * still has to match what is on screen (an older draft may predate the
   * markdown projection entirely). Publishing does NOT force — there the
   * publish itself carries the words.
   */
  async function runSave(force = false): Promise<string | null> {
    if (editing || savingRef.current) return null;
    if (publishingRef.current && !force) return null;
    if (!editor) return null;
    if (!dirtyRef.current && !force) return draftIdRef.current;
    const title = titleRef.current?.value ?? "";
    const dek = dekRef.current?.value ?? "";
    const blocks = editor.document;
    const markdown = editor.blocksToMarkdownLossy(blocks);
    // Only when this session actually uploaded something — see postDraft.
    const inlineImages = imageStore.size > 0 ? imageStore.toField() : undefined;
    // A subtitle alone is worth a draft row too — it's words the writer typed.
    if (
      !draftIdRef.current &&
      title.trim() === "" &&
      dek.trim() === "" &&
      isBlankDocument(blocks)
    )
      return null;
    savingRef.current = true;
    dirtyRef.current = false;
    setSaveState("saving");
    let next: SaveState = "error";
    try {
      let res = await postDraft({
        id: draftIdRef.current ?? undefined,
        title,
        dek,
        content: blocks,
        markdown,
        inlineImages,
      });
      if (res.status === 404 && draftIdRef.current && !publishingRef.current) {
        // The draft was deleted elsewhere (another tab, the dashboard) —
        // recreate it rather than lose what's on screen. Never during a
        // publish: there the deletion IS the completion, and recreating
        // would resurrect the just-published draft.
        draftIdRef.current = null;
        res = await postDraft({
          title,
          dek,
          content: blocks,
          markdown,
          inlineImages,
        });
      }
      if (res.ok) {
        const data = (await res.json()) as { draft?: { id?: string } };
        if (!draftIdRef.current && typeof data.draft?.id === "string") {
          draftIdRef.current = data.draft.id;
          // Make refresh/back resume this draft. replaceState, not a router
          // navigation: the loader must not re-run under the writer's
          // cursor. (The router's in-memory location goes stale, which is
          // fine while all site chrome navigates with full-page <a> links —
          // revisit if /write ever gains client-side <Link> nav.)
          window.history.replaceState(
            null,
            "",
            `/write?draft=${data.draft.id}`,
          );
        }
        next = "saved";
      } else {
        dirtyRef.current = true;
        next = res.status === 409 ? "limit" : "error";
      }
    } catch {
      dirtyRef.current = true;
      next = "error";
    } finally {
      savingRef.current = false;
      setSaveState(next);
      // Edits landed while the save was in flight: pick them up. Failures
      // don't self-reschedule (no retry loop) — the next keystroke or blur
      // tries again.
      if (next === "saved" && dirtyRef.current) scheduleSave();
    }
    return next === "saved" ? draftIdRef.current : null;
  }

  /** Runs a save and tracks it, so publish can await an in-flight one. */
  function saveDraft(force = false): Promise<string | null> {
    const run = runSave(force).finally(() => {
      if (saveInFlightRef.current === run) saveInFlightRef.current = null;
    });
    saveInFlightRef.current = run;
    return run;
  }

  /**
   * What the Schedule button waits for: the in-flight save, then a forced one,
   * resolving to the draft id the schedule will point at.
   *
   * A scheduled post publishes WHAT IS STORED, hours later, with nobody
   * watching — so the stored row has to be the screen before a due date is
   * saved. A failed save therefore schedules nothing at all; SchedulePanel says
   * so rather than queueing older words.
   */
  async function prepareForSchedule(): Promise<string | null> {
    clearSaveTimer();
    const pending = saveInFlightRef.current;
    if (pending) await pending.catch(() => null);
    return saveDraft(true);
  }

  function scheduleSave() {
    // Trailing throttle, not a resetting debounce: an already-armed timer
    // keeps its deadline, so continuous typing still saves every few
    // seconds instead of starving the save forever.
    if (timerRef.current) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void saveDraft();
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  /** Title keystrokes and editor changes both funnel here. */
  function handleDraftChange() {
    // Accessibility first, and regardless of autosave: an image with no alt
    // text is unreadable to a screen reader, so the count has to track the
    // document even when the draft itself is never saved (an edit of a
    // published post).
    if (editor) {
      setMissingAlt(imagesMissingAltText(editor.document));
      setRemoteImages(countRemoteImages(editor.document));
    }
    if (publishingRef.current || !readyRef.current) return;
    // Marked dirty on both surfaces so the leave-page guard applies; only new
    // compositions go on to schedule a save. (The ready check matters here —
    // loading a post into the editor fires onChange, and treating hydration as
    // an edit would prompt a writer who has changed nothing.)
    dirtyRef.current = true;
    if (editing) return;
    scheduleSave();
  }

  /** Enter in the title moves on to the subtitle rather than breaking the
   * line: a record title is one line, and the writer's next thought belongs in
   * the field below. */
  function handleTitleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    dekRef.current?.focus();
  }

  /** Blur is a natural pause — flush the pending save immediately. (React's
   * onBlur is focusout, so it bubbles here from the title and the editor.) */
  function handleBlur() {
    if (editing || !dirtyRef.current) return;
    clearSaveTimer();
    void saveDraft();
  }

  // Native constraint validation runs before the submit event fires, so the
  // fields are valid here; export the blocks to markdown, then submit for real
  // (form.submit() does not re-fire this handler).
  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || !bodyRef.current || coverBusy || publishingRef.current)
      return;
    // Publishing supersedes autosave: stop the timer and hand the draft id to
    // the server, which removes the completed draft after the record lands.
    publishingRef.current = true;
    clearSaveTimer();
    const form = event.currentTarget;
    const submit = () => {
      if (draftIdInputRef.current)
        draftIdInputRef.current.value = draftIdRef.current ?? "";
      if (bodyRef.current)
        bodyRef.current.value = editor.blocksToMarkdownLossy(editor.document);
      if (imagesInputRef.current)
        imagesInputRef.current.value = imageStore.toField();
      form.submit();
    };
    // Clicking Publish blurs the editor, so a save may be mid-flight — and it
    // may be CREATING the draft row. Wait for it so the fresh id rides the
    // publish form and the server can complete (delete) the draft; otherwise
    // the row would outlive its own publish as an orphan.
    const pending = saveInFlightRef.current;
    if (pending) void pending.finally(submit);
    else submit();
  }

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-10">
      <ErrorNotice code={error} />
      {unscheduled && (
        <Notice tone="info">
          Schedule cancelled — this is a draft again, and nothing will publish
          on its own.
        </Notice>
      )}
      {error === "cover_scope" && reconnectHandle && (
        <form action="/login" className="-mt-4 mb-6" method="post">
          <input name="handle" type="hidden" value={reconnectHandle} />
          <input name="returnTo" type="hidden" value="/write" />
          <button
            className="cursor-pointer font-display font-semibold text-ink text-sm underline underline-offset-2"
            type="submit"
          >
            Re-connect your account
          </button>{" "}
          <span className="font-display text-ink-soft text-sm">
            — you'll approve the new permission on your own server.
          </span>
        </form>
      )}
      <noscript>
        <p className="mb-6 border border-ink px-4 py-3 font-display text-ink text-sm">
          The editor needs JavaScript. Enable it to write on Goldroad.
        </p>
      </noscript>
      {/* The BlockNote editor must live OUTSIDE the publish <form>: its UI
          buttons (side-menu +, drag handle, slash-menu items) don't set
          type="button", and a type-less button inside a form is a submit
          button — hovering a block and pressing + would publish the post.
          The form wraps only the inputs; the Publish button re-joins it from
          outside via the form attribute (and stays the form's default button,
          so Enter in the title still publishes deliberately). The wrapper div
          carries onBlur (focusout bubbles) so both the title and the editor
          keep flushing pending autosaves. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: not an interactive control — a bubbling focusout relay for the autosave flush */}
      <div onBlur={handleBlur}>
        {/* Autosave status leads the page: visible while writing, rather than
            a screen away at the bottom of a long draft. */}
        {!editing && <SaveIndicator state={saveState} />}
        <form
          action="/api/publish"
          encType="multipart/form-data"
          id="publish-form"
          method="post"
          onSubmit={handleSubmit}
        >
          {editing && <input name="rkey" type="hidden" value={draft.rkey} />}
          {/* Mirrored post (imported; the original lives elsewhere): editing
              offers adoption — one deliberate checkbox, submitted with the
              save. Adopting stops the "originally published at" note and lets
              search engines index this page as the post's home. */}
          {editing && draft.mirror && (
            <div className="mb-6 border border-rule px-4 py-3">
              <p className="font-display text-ink-soft text-sm leading-relaxed">
                This post is a mirror — readers see a note pointing to the
                original{mirrorHost ? ` at ${mirrorHost}` : ""}, and search
                engines are told to index the original, not this copy.
              </p>
              <label className="mt-2 flex min-h-9 cursor-pointer items-center gap-2 font-display text-ink text-sm">
                <input name="adoptOriginal" type="checkbox" value="1" />
                Make this the Goldroad original — remove the note and let this
                page be indexed
              </label>
            </div>
          )}
          {!editing && (
            <input name="draftId" ref={draftIdInputRef} type="hidden" />
          )}
          <input name="body" ref={bodyRef} type="hidden" />
          {/* The blobs this session uploaded. The server keeps only the ones
              the submitted body still references. */}
          <input name="images" ref={imagesInputRef} type="hidden" />
          <CoverPicker
            existingPath={draft?.coverPath ?? null}
            onBusyChange={setCoverBusy}
          />
          {/* Title and subtitle carry the type of the published page (serif,
              same sizes, same italic dek) so the draft reads as the piece it
              will become rather than as a form. Focus shows as a spot rule
              under the line being written; the global focus ring is opted out
              of here so a box never wraps the manuscript's own words. */}
          <label className="sr-only" htmlFor="title">
            Title
          </label>
          {/* A textarea, not a text input: a long title has to WRAP the way it
              will on the published page, and a single-line input scrolls it
              out of sight instead. Enter is caught below so the field still
              behaves like one line of writing — no newlines in a title, and no
              accidental publish. */}
          <textarea
            className="field-sizing-content w-full resize-none overflow-hidden rounded-none border-0 border-transparent border-b-2 bg-paper px-1 py-1 font-body font-semibold text-4xl text-ink leading-[1.1] placeholder:text-ink-soft/40 focus-visible:border-spot focus-visible:outline-none md:text-5xl"
            defaultValue={draft?.title ?? resumed?.title ?? ""}
            id="title"
            name="title"
            onChange={handleDraftChange}
            onKeyDown={handleTitleKeyDown}
            placeholder="Title"
            ref={titleRef}
            required
            rows={1}
          />
          <SubtitleField
            defaultValue={draft?.dek ?? resumed?.dek ?? ""}
            fieldRef={dekRef}
            onChange={handleDraftChange}
          />
        </form>
        <div className="mt-8 min-h-[26rem] border-rule border-t pt-8 text-lg">
          <ClientOnly fallback={<EditorFallback />}>
            <Suspense fallback={<EditorFallback />}>
              <Editor
                imageStore={imageStore}
                initialBlocks={initialBlocks}
                initialMarkdown={draft?.textContent || undefined}
                onChange={handleDraftChange}
                onReady={handleEditorReady}
              />
            </Suspense>
          </ClientOnly>
        </div>
        {/* Images added to an unpublished draft are already in the writer's
            repo, but a PDS only serves a blob some record references — so
            after a reload they stay blank until this draft publishes. Said
            here rather than left to be discovered as breakage. */}
        {!editing && resumedHasImages && (
          <p className="mt-4 font-display text-ink-soft text-xs leading-relaxed">
            Images in this draft are already saved to your repo, but they stay
            blank here until you publish — that's when your server starts
            serving them.
          </p>
        )}
        {/* An imported draft's images still live on the source's servers, and
            publishing copies them into the writer's repo. That spends their
            quota, so it is said BEFORE the button, not discovered after. */}
        {!editing && resumed?.imported && remoteImages > 0 && (
          <p className="mt-4 font-display text-ink-soft text-xs leading-relaxed">
            {remoteImages === 1
              ? "This post has one image still hosted by the site you imported from. Publishing saves a copy to your own repo — it counts against your storage there — so the post keeps working if the original disappears."
              : `This post has ${remoteImages} images still hosted by the site you imported from. Publishing saves copies to your own repo — they count against your storage there — so the post keeps working if the originals disappear.`}
          </p>
        )}
        {/* Alt text is what a screen reader has to work with, and the only
            person who can write it is the person who chose the picture. A
            count, not a block: it's the writer's call. */}
        {missingAlt > 0 && (
          <p className="mt-4 font-display text-ink-soft text-xs leading-relaxed">
            {missingAlt === 1
              ? "One image has no alt text — select it and use “Edit alt text” to describe it for readers who can't see it."
              : `${missingAlt} images have no alt text — select each one and use “Edit alt text” to describe it for readers who can't see it.`}
          </p>
        )}
        {/* The consequence of the button is stated beside the button, where the
            decision is actually made.

            Ink, not spot: the rail's "New post" carries the one vermillion
            moment on every signed-in surface (docs/DESIGN.md, and
            `RailPrimaryAction` in ~/components/site-chrome), so this is the
            page's primary button without being the page's accent. */}
        <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-3 border-rule border-t pt-6">
          <button
            className="min-h-11 cursor-pointer bg-ink px-8 py-2.5 font-bold font-display text-base text-paper transition-colors hover:bg-spot disabled:cursor-default disabled:opacity-40"
            disabled={!editor || coverBusy}
            form="publish-form"
            type="submit"
          >
            {editing ? "Save changes" : "Publish"}
          </button>
          <p className="font-display text-ink-soft text-xs leading-relaxed">
            {editing
              ? "Saves the changes to the post in your own data repo."
              : "Goes live on your public page the moment you press it, and saves to your own data repo — the account behind your handle. It's yours; Goldroad just holds the pen."}
          </p>
        </div>
        {/* Scheduling is only offered for a new composition. Editing changes a
            record that is ALREADY public — there is nothing to queue, and a
            date picker there would imply otherwise. */}
        {!editing && (
          <SchedulePanel
            disabled={!editor || coverBusy}
            draftId={resumed?.id ?? null}
            existing={resumed?.schedule ?? null}
            prepare={prepareForSchedule}
          />
        )}
      </div>
    </main>
  );
}

function WritePage() {
  const { viewer, draft, resumed, draftError } = Route.useLoaderData();
  const { error, handle, returnTo, unscheduled } = Route.useSearch();
  if (!viewer) {
    return (
      <AppShell header={{ variant: "signed-out" }}>
        <SignIn error={error} handle={handle} returnTo={returnTo} />
      </AppShell>
    );
  }
  return (
    <AppShell
      header={{
        // No active row: the editor is an act, not a place. Writers navigate
        // away mid-draft (autosave makes that safe), so the rail stays — it
        // just doesn't pretend the writer is "at" a destination.
        variant: "signed-in",
        ident: viewer.handle ?? viewer.did,
      }}
    >
      {/* Keyed by the edit/resume target: switching between editing, resuming
          a draft, and a fresh page remounts the form (title defaultValue +
          editor state would otherwise go stale on client-side navigation and
          duplicate posts). */}
      <Compose
        draft={draft}
        error={error ?? draftError}
        key={draft?.rkey ?? resumed?.id ?? "new"}
        reconnectHandle={viewer.handle}
        resumed={resumed}
        unscheduled={unscheduled}
      />
    </AppShell>
  );
}
