import { ClientOnly, createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { lazy, Suspense, useRef, useState } from "react";

import type { BlockNoteEditor } from "~/components/editor";
import { ExternalLink } from "~/components/external-link";
import { Notice } from "~/components/notice";
import { AppShell } from "~/components/site-chrome";
import {
  getRecord,
  resolveDidToHandle,
  resolveDidToPds,
  type StandardDocument,
} from "~/lib/atproto";
import { blobImagePath, coverImageCid } from "~/lib/blob";
import { downscaleImage } from "~/lib/image";
import { TID_RE } from "~/lib/publish";
import { readSessionDid } from "~/lib/session";
import { env } from "cloudflare:workers";

// BlockNote is client-only (ProseMirror needs a real DOM): lazy + ClientOnly
// keeps it out of SSR and out of the worker's hot path entirely.
const Editor = lazy(() => import("~/components/editor"));

const ERROR_MESSAGES: Record<string, string> = {
  invalid_handle:
    "That doesn't look like a Bluesky handle — it's usually name.bsky.social, or your own domain. Check for typos and try again.",
  handle_not_found:
    "We couldn't find that handle on the network — check the spelling and try again, or wait a moment if its server is having trouble.",
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
  textContent: string;
  /** Same-origin /img path for the existing cover, when the record has one. */
  coverPath: string | null;
};

const getWriteContext = createServerFn({ method: "GET" })
  .validator((data: { edit?: string }) => ({
    edit:
      typeof data.edit === "string" && TID_RE.test(data.edit)
        ? data.edit
        : undefined,
  }))
  .handler(async ({ data }) => {
    const did = await readSessionDid(getRequest(), env.COOKIE_SECRET);
    if (!did)
      return { viewer: null, draft: null, draftError: undefined } as const;
    const handle = await resolveDidToHandle(did).catch(() => null);

    let draft: Draft | null = null;
    let draftError: "not_found" | "not_editable" | undefined;
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
          draft = {
            rkey: data.edit,
            title: doc.title ?? "",
            textContent: doc.textContent ?? "",
            coverPath: coverCid ? blobImagePath(did, coverCid) : null,
          };
        }
      } catch {
        draftError = "not_found";
      }
    }
    return { viewer: { did, handle }, draft, draftError } as const;
  });

export const Route = createFileRoute("/write")({
  validateSearch: (search: Record<string, unknown>) => {
    const out: { error?: string; edit?: string; handle?: string } = {};
    if (typeof search.error === "string") out.error = search.error;
    if (typeof search.edit === "string") out.edit = search.edit;
    // /login sends the entered handle back so the sign-in form can prefill it.
    if (typeof search.handle === "string") out.handle = search.handle;
    return out;
  },
  loaderDeps: ({ search }) => ({ edit: search.edit }),
  loader: ({ deps }) => getWriteContext({ data: { edit: deps.edit } }),
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
}: {
  error: string | undefined;
  /** What the writer entered on a failed attempt — prefilled for correction. */
  handle: string | undefined;
}) {
  const message = errorMessage(error);
  return (
    <main className="mx-auto w-full max-w-md px-6 py-16 md:py-24">
      <h1 className="font-black font-display text-3xl text-ink tracking-tight">
        Sign in to write
      </h1>
      <p className="mt-3 font-body text-ink-soft leading-relaxed">
        Your press runs on your own account — sign in with your Bluesky (or any
        atproto) handle.
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
        <input name="returnTo" type="hidden" value="/write" />
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
        — it becomes your byline here.
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
    <div className="mb-6">
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
            className="max-h-64 w-full border border-rule object-cover"
            src={preview}
          />
          <div className="mt-1 flex flex-wrap items-center gap-x-4">
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
        <label className={linkClass} htmlFor="cover">
          + Add a cover image
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

function Compose({
  draft,
  error,
  reconnectHandle,
}: {
  draft: Draft | null;
  error: string | undefined;
  /** Handle for the one-click re-connect form on scope errors. */
  reconnectHandle: string | null;
}) {
  const [editor, setEditor] = useState<BlockNoteEditor | null>(null);
  const [coverBusy, setCoverBusy] = useState(false);
  const bodyRef = useRef<HTMLInputElement>(null);
  const editing = draft !== null;

  // Native constraint validation runs before the submit event fires, so the
  // fields are valid here; export the blocks to markdown, then submit for real
  // (form.submit() does not re-fire this handler).
  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || !bodyRef.current || coverBusy) return;
    bodyRef.current.value = editor.blocksToMarkdownLossy(editor.document);
    event.currentTarget.submit();
  }

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-10">
      <ErrorNotice code={error} />
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
      {!editing && (
        <p className="mb-8 max-w-prose font-display text-ink-soft text-sm leading-relaxed">
          Publishing saves this post to your own data repo — the same account
          behind your handle — and puts it live on your public page. It's yours;
          Goldroad just holds the pen.
        </p>
      )}
      <noscript>
        <p className="mb-6 border border-ink px-4 py-3 font-display text-ink text-sm">
          The editor needs JavaScript. Enable it to write on Goldroad.
        </p>
      </noscript>
      <form
        action="/api/publish"
        encType="multipart/form-data"
        method="post"
        onSubmit={handleSubmit}
      >
        {editing && <input name="rkey" type="hidden" value={draft.rkey} />}
        <input name="body" ref={bodyRef} type="hidden" />
        <CoverPicker
          existingPath={draft?.coverPath ?? null}
          onBusyChange={setCoverBusy}
        />
        <label className="sr-only" htmlFor="title">
          Title
        </label>
        <input
          className="w-full rounded-none border-0 border-transparent border-b-2 bg-paper px-1 py-2 font-semibold text-3xl text-ink leading-tight placeholder:text-ink-soft/50 focus-visible:border-spot focus-visible:outline-none md:text-4xl"
          defaultValue={draft?.title ?? ""}
          id="title"
          name="title"
          placeholder="Title"
          required
          type="text"
        />
        <div className="-mx-1 mt-4 min-h-96 border-rule border-t pt-5 text-lg">
          <ClientOnly fallback={<EditorFallback />}>
            <Suspense fallback={<EditorFallback />}>
              <Editor
                initialMarkdown={draft?.textContent || undefined}
                onReady={setEditor}
              />
            </Suspense>
          </ClientOnly>
        </div>
        <div className="mt-8 flex flex-wrap items-center gap-4 border-rule border-t pt-6">
          <button
            className="min-h-11 cursor-pointer bg-spot px-8 py-2.5 font-bold font-display text-base text-paper transition-colors hover:bg-ink disabled:cursor-default disabled:opacity-40"
            disabled={!editor || coverBusy}
            type="submit"
          >
            {editing ? "Save changes" : "Publish"}
          </button>
          <p className="font-display text-ink-soft text-xs">
            {editing
              ? "Saves the changes to the post in your own data repo."
              : "Goes live on your public page the moment you press it."}
          </p>
        </div>
      </form>
    </main>
  );
}

function WritePage() {
  const { viewer, draft, draftError } = Route.useLoaderData();
  const { error, handle } = Route.useSearch();
  if (!viewer) {
    return (
      <AppShell header={{ variant: "signed-out" }}>
        <SignIn error={error} handle={handle} />
      </AppShell>
    );
  }
  return (
    <AppShell
      header={{
        variant: "signed-in",
        ident: viewer.handle ?? viewer.did,
        active: "write",
      }}
    >
      {/* Keyed by the edit target: switching between editing and a fresh
          draft remounts the form (title defaultValue + editor state would
          otherwise go stale on client-side navigation and duplicate posts). */}
      <Compose
        draft={draft}
        error={error ?? draftError}
        key={draft?.rkey ?? "new"}
        reconnectHandle={viewer.handle}
      />
    </AppShell>
  );
}
