import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { ExternalLink } from "~/components/external-link";
import { Notice } from "~/components/notice";
import { AppShell } from "~/components/site-chrome";
import {
  resetTurnstileWidgets,
  TURNSTILE_TOKEN_FIELD,
  TurnstileWidget,
} from "~/components/turnstile";

/**
 * Report a page (moderation kit, audit #1). Pressroom register — we're speaking
 * as Goldroad here, not rendering a writer. The reading-surface "Report" link
 * prefills `?url`; the form posts JSON to /api/report (same client-fetch shape
 * as the waitlist). No-JS is a known degradation, acceptable for MVP.
 */
export const Route = createFileRoute("/report")({
  validateSearch: (search: Record<string, unknown>) => ({
    url: typeof search.url === "string" ? search.url.slice(0, 2048) : "",
  }),
  head: () => ({
    meta: [
      { title: "Report content — Goldroad" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ReportPage,
});

type FormState = "idle" | "sending" | "done" | "error";

function ReportForm({ initialUrl }: { initialUrl: string }) {
  const [state, setState] = useState<FormState>("idle");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setState("sending");
    // Present only when the Turnstile widget rendered (sitekey configured);
    // without it the payload stays exactly the pre-Turnstile shape.
    const turnstileToken = data.get(TURNSTILE_TOKEN_FIELD);
    try {
      const res = await fetch("/api/report", {
        body: JSON.stringify({
          gr_extra: String(data.get("gr_extra") ?? ""),
          url: String(data.get("url") ?? ""),
          reason: String(data.get("reason") ?? ""),
          email: String(data.get("email") ?? ""),
          ...(typeof turnstileToken === "string"
            ? { [TURNSTILE_TOKEN_FIELD]: turnstileToken }
            : {}),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (!res.ok) throw new Error(String(res.status));
      setState("done");
      form.reset();
    } catch {
      // Tokens are single-use: the failed submit consumed this one, so the
      // widget must re-arm or every retry would resend a dead token.
      resetTurnstileWidgets();
      setState("error");
    }
  }

  if (state === "done") {
    return (
      <Notice tone="info">
        Thank you — your report reached us. A human reviews every report against
        our content policies. We may follow up if you left an email.
      </Notice>
    );
  }

  return (
    <form
      className="mt-8 flex flex-col gap-4 border-2 border-ink p-6"
      onSubmit={submit}
    >
      {/* Honeypot — humans never see it; a filled value is a bot. */}
      <input
        aria-hidden="true"
        autoComplete="off"
        className="absolute -left-[9999px] h-px w-px"
        id="gr_extra"
        name="gr_extra"
        tabIndex={-1}
        type="text"
      />
      <div className="flex flex-col gap-2">
        <label
          className="font-bold font-display text-ink text-sm"
          htmlFor="url"
        >
          Page URL
        </label>
        <input
          className="min-h-11 border border-ink bg-paper px-4 py-2.5 font-body text-base text-ink placeholder:text-ink-soft"
          defaultValue={initialUrl}
          id="url"
          name="url"
          placeholder="https://trygoldroad.com/@handle/…"
          required
          type="url"
        />
      </div>
      <div className="flex flex-col gap-2">
        <label
          className="font-bold font-display text-ink text-sm"
          htmlFor="reason"
        >
          What's wrong with it?
        </label>
        <textarea
          className="min-h-28 border border-ink bg-paper px-4 py-2.5 font-body text-base text-ink placeholder:text-ink-soft"
          id="reason"
          name="reason"
          placeholder="Tell us what you're reporting and why."
          required
        />
      </div>
      <div className="flex flex-col gap-2">
        <label
          className="font-bold font-display text-ink text-sm"
          htmlFor="email"
        >
          Your email{" "}
          <span className="font-normal text-ink-soft">(optional)</span>
        </label>
        <input
          className="min-h-11 border border-ink bg-paper px-4 py-2.5 font-body text-base text-ink placeholder:text-ink-soft"
          id="email"
          inputMode="email"
          name="email"
          placeholder="you@example.com"
          type="email"
        />
      </div>
      <button
        className="min-h-11 cursor-pointer bg-spot px-6 py-2.5 font-bold font-display text-base text-paper transition-colors hover:bg-ink disabled:opacity-60"
        disabled={state === "sending"}
        type="submit"
      >
        {state === "sending" ? "Sending…" : "Send report"}
      </button>
      {/* Anti-bot challenge — renders only when the sitekey env var is set. */}
      <TurnstileWidget />
      {state === "error" && (
        <p className="font-display text-sm text-spot" role="alert">
          That didn't go through — check the URL and try again.
        </p>
      )}
    </form>
  );
}

function ReportPage() {
  const { url } = Route.useSearch();
  return (
    <AppShell header={{ variant: "signed-out" }}>
      <main className="mx-auto w-full max-w-xl px-6 py-16 md:py-24">
        <h1 className="font-black font-display text-3xl text-ink tracking-tight">
          Report content
        </h1>
        <p className="mt-3 max-w-prose font-body text-ink-soft leading-relaxed">
          Goldroad renders writing published to the open AT Protocol network. If
          a page here breaks our{" "}
          <a
            className="underline underline-offset-2 transition-colors hover:text-ink"
            href="/policies"
          >
            content policies
          </a>{" "}
          — or you have a copyright or legal concern — tell us and a human will
          review it.
        </p>
        <p className="mt-3 max-w-prose font-display text-ink-soft text-sm leading-relaxed">
          You can also email{" "}
          <ExternalLink
            className="underline underline-offset-2 transition-colors hover:text-ink"
            href="mailto:abuse@trygoldroad.com"
          >
            abuse@trygoldroad.com
          </ExternalLink>
          .
        </p>
        <ReportForm initialUrl={url} />
      </main>
    </AppShell>
  );
}
