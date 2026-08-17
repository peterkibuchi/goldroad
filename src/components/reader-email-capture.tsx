/**
 * The reader's email, left with a publication — the second act a reader can
 * take on a writer's page, beside the subscribe control it sits under.
 *
 * IT SAYS WHAT IS TRUE TODAY, WHICH IS THAT NOTHING SENDS YET. Email delivery
 * is not built. Every version of this that reads better says something we cannot
 * keep — a date, a first issue, a welcome note — so the copy states the fact
 * flatly and lets the reader decide anyway: an address left now is an address the
 * writer has on the day sending opens, which is the only thing being offered.
 * There is no invite language anywhere in it and there must not be: there is no
 * gate on the other side of this field, and a scarcity that doesn't exist is the
 * exact dishonesty `marketing-claims.test.ts` was written to stop.
 *
 * IT ONLY APPEARS ON PUBLICATIONS HOSTED HERE, and that gate is the honesty
 * half of rendering any atproto author's records. These pages render writers who
 * have never heard of Goldroad — a Leaflet or pckt author's essays read here
 * exactly as ours do — and offering to pass an address to someone with no account
 * here would collect it for a person who could never receive it, while naming
 * them as its controller. So the publication record's own `url` has to be one we
 * mint (`isOwnPublicationUrl`), which is the same ownership guard publishing uses.
 * In local development that means setting `VITE_PUBLIC_ORIGIN` to the loopback
 * origin, because records created locally carry loopback URLs.
 *
 * CALM REGISTER, INK, NEVER THE SPOT COLOUR — the same rule and the same reason
 * as ~/components/subscribe-control, whose button vocabulary this shares: the
 * accent moment on a reading page belongs to the writer's words, and a vermillion
 * button here would be Goldroad shouting on someone else's page. No modal, ever.
 * A reader is mid-essay; interrupting them to ask for an address would be the
 * loudest thing on the surface and would earn the least.
 *
 * IT WORKS WITHOUT JAVASCRIPT. The markup is a real form with a real `action`,
 * so a browser that runs none of our code still posts it and lands on
 * /subscribed. With JavaScript the submit is intercepted and the outcome renders
 * in place, which is better but is not the floor.
 */
import { useId, useState } from "react";

import {
  READER_ACTION,
  READER_ACTION_OUTLINE,
} from "~/components/subscribe-control";
import {
  resetTurnstileWidgets,
  TURNSTILE_TOKEN_FIELD,
  TurnstileWidget,
} from "~/components/turnstile";
import { CANONICAL_ORIGIN, ownOrigins } from "~/lib/origin";
import { capture } from "~/lib/posthog";
import { isOwnPublicationUrl } from "~/lib/publish";
import { cn } from "~/lib/utils";

type FormState = "idle" | "sending" | "done" | "error";

/** Which reading surface the address was left on — stored, because "the essay
 * earned it" and "the archive earned it" are different facts and neither is
 * recoverable later. */
export type CaptureSource = "post" | "publication";

const FINE_PRINT =
  "basis-full font-display text-[0.8125rem] text-ink-soft leading-relaxed";

const PRIVACY_LINK =
  "underline underline-offset-2 transition-colors hover:text-ink";

export function ReaderEmailCapture({
  writerDid,
  publicationUrl,
  publicationName,
  ident,
  source,
  className,
}: {
  /** The publication writer's DID — the controller of the address. */
  writerDid?: string | null;
  /** The publication record's own url, which decides whether this renders. */
  publicationUrl?: string | null;
  /** The publication's name, for the copy. Falls back to the handle. */
  publicationName?: string | null;
  /** The handle (or DID) of the page, for the no-JS confirmation's link back. */
  ident: string;
  source: CaptureSource;
  className?: string;
}) {
  const [state, setState] = useState<FormState>("idle");
  const emailId = useId();
  const honeypotId = useId();

  const name = publicationName?.trim() || `@${ident}`;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setState("sending");
    // Present only when the Turnstile widget rendered (sitekey configured);
    // without it the payload is exactly the shape the schema describes.
    const turnstileToken = data.get(TURNSTILE_TOKEN_FIELD);
    try {
      const res = await fetch("/api/subscribe", {
        body: JSON.stringify({
          gr_extra: String(data.get("gr_extra") ?? ""),
          email: String(data.get("email") ?? ""),
          writerDid: String(data.get("writerDid") ?? ""),
          source: String(data.get("source") ?? ""),
          ident: String(data.get("ident") ?? ""),
          ...(typeof turnstileToken === "string"
            ? { [TURNSTILE_TOKEN_FIELD]: turnstileToken }
            : {}),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (!res.ok) throw new Error(String(res.status));
      // On a confirmed write only. The properties are the writer's DID and which
      // surface asked — both public. The READER'S ADDRESS IS NEVER AN EVENT
      // PROPERTY, here or anywhere (~/lib/posthog's property policy).
      capture("reader_email_left", { writer: writerDid, source });
      setState("done");
      form.reset();
    } catch {
      // Tokens are single-use: the failed submit consumed this one, so the
      // widget must re-arm or every retry would resend a dead token.
      resetTurnstileWidgets();
      setState("error");
    }
  }

  // Nothing to offer: no writer to hold the address, or a publication this
  // instance doesn't host (see the module comment).
  if (!writerDid) return null;
  if (
    !isOwnPublicationUrl(
      publicationUrl ?? undefined,
      ownOrigins(CANONICAL_ORIGIN),
    )
  )
    return null;

  return (
    <div className={cn("max-w-[46ch]", className)}>
      {state === "done" ? (
        <>
          <p className="font-display font-semibold text-ink text-sm">
            {name} has your address.
          </p>
          <p className={cn(FINE_PRINT, "mt-2")}>
            Sending isn't switched on yet, so nothing will arrive today.{" "}
            <a className={PRIVACY_LINK} href="/privacy">
              How it's held
            </a>
            .
          </p>
        </>
      ) : (
        <form
          action="/api/subscribe"
          className="flex flex-wrap items-center gap-3"
          method="post"
          onSubmit={submit}
        >
          {/* The label IS the heading — one line doing both jobs, rather than a
              heading with a redundant "Email address" beneath it. */}
          <label
            className="basis-full font-display font-semibold text-ink text-sm"
            htmlFor={emailId}
          >
            New posts by email
          </label>
          {/* Honeypot: humans never see it; a filled value is a bot. Named
              opaquely — Chrome autofills recognizable names (company, etc.) even
              when hidden, which would reject real readers (crbug 40223868). */}
          <input
            aria-hidden="true"
            autoComplete="off"
            className="absolute -left-[9999px] h-px w-px"
            id={honeypotId}
            name="gr_extra"
            tabIndex={-1}
            type="text"
          />
          <input name="writerDid" type="hidden" value={writerDid} />
          <input name="source" type="hidden" value={source} />
          {/* Only ever used to build the link back on the no-JS confirmation. */}
          <input name="ident" type="hidden" value={ident} />
          {/* 16px at base and no step down: this is a public page, and a control
              under 16px zooms iOS Safari in on focus and never back out. */}
          <input
            autoComplete="email"
            className="min-h-11 min-w-56 flex-1 border border-ink bg-paper px-3 py-2 font-body text-base text-ink placeholder:text-ink-soft/70"
            id={emailId}
            inputMode="email"
            name="email"
            placeholder="you@example.com"
            required
            type="email"
          />
          <button
            aria-busy={state === "sending" || undefined}
            className={cn(READER_ACTION, READER_ACTION_OUTLINE)}
            disabled={state === "sending"}
            type="submit"
          >
            {state === "sending" ? "Saving…" : "Leave my email"}
          </button>
          {/* Anti-bot challenge — renders only when the sitekey env var is set. */}
          <TurnstileWidget />
          <p className={FINE_PRINT}>
            Sending isn't switched on here yet — leave your address and {name}{" "}
            can write to you once it is.{" "}
            <a className={PRIVACY_LINK} href="/privacy">
              How it's held
            </a>
            .
          </p>
          {state === "error" && (
            // Ink, not spot: a submit that didn't go through is a fact about our
            // plumbing, and the page's accent moment isn't ours to spend.
            <p
              className="basis-full font-display font-semibold text-[0.8125rem] text-ink"
              role="alert"
            >
              That didn't go through — check the address and try again.
            </p>
          )}
        </form>
      )}
      {/* Announced for a reader who can't see the swap above. Mounted from the
          first paint so the live region exists before it has anything to say. */}
      <span className="sr-only" role="status">
        {state === "done" && `Saved. ${name} has your address.`}
      </span>
    </div>
  );
}
