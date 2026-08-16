import { AppShell } from "~/components/site-chrome";
import { MAIN_CONTENT_ID } from "~/components/skip-link";

/**
 * System pages — 404, error boundary, route-pending skeleton. System
 * messages are plain and outcome-first — zero press metaphor (the visual
 * system carries the register; the words carry the facts). The pending
 * skeleton stays calm and shape-neutral because most slow loads are reading
 * surfaces waiting on a writer's PDS.
 */

export function NotFoundPage() {
  return (
    <AppShell header={{ variant: "signed-out" }}>
      <main
        className="mx-auto w-full max-w-2xl px-6 py-20 md:py-28"
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
      >
        <p className="font-black font-display text-7xl text-ink tracking-tight md:text-8xl">
          404<span className="text-spot">.</span>
        </p>
        <h1 className="mt-6 text-balance font-black font-display text-2xl text-ink tracking-tight md:text-3xl">
          There's nothing at this address.
        </h1>
        <p className="mt-4 max-w-[52ch] text-ink-soft text-lg">
          The address may be mistyped, or whatever lived here has moved on.
          Nothing is lost — everything published on Goldroad stays in its
          writer's own archive.
        </p>
        <p className="mt-8">
          <a
            className="inline-flex min-h-11 items-center bg-ink px-6 font-bold font-display text-base text-paper transition-colors hover:bg-spot"
            href="/"
          >
            Go to the front page
          </a>
        </p>
      </main>
    </AppShell>
  );
}

export function ErrorPage({ error }: { error: Error }) {
  return (
    <AppShell header={{ variant: "signed-out" }}>
      <main
        className="mx-auto w-full max-w-2xl px-6 py-20 md:py-28"
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
      >
        <h1 className="text-balance font-black font-display text-3xl text-ink tracking-tight md:text-4xl">
          Something went wrong.
        </h1>
        <p className="mt-4 max-w-[52ch] text-ink-soft text-lg">
          This page failed to load on our side. Your writing is safe in your own
          data repo, not lost — try again in a moment.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-4">
          <button
            className="inline-flex min-h-11 cursor-pointer items-center bg-ink px-6 font-bold font-display text-base text-paper transition-colors hover:bg-spot"
            onClick={() => {
              // A full reload re-runs the failed loader from scratch — honest
              // recovery for transient PDS/network failures.
              window.location.reload();
            }}
            type="button"
          >
            Try again
          </button>
          <a
            className="inline-flex min-h-11 items-center font-display text-ink-soft text-sm underline underline-offset-2 transition-colors hover:text-ink"
            href="/"
          >
            Go to the front page
          </a>
        </div>
        {import.meta.env.DEV && (
          <pre className="mt-10 overflow-x-auto border border-rule p-4 font-mono text-ink-soft text-xs">
            {error.message}
          </pre>
        )}
      </main>
    </AppShell>
  );
}

/**
 * Route-pending state. Policy: skeletons, never spinners —
 * shape-neutral pulsing bars in the calm register. Shown by the router only
 * after its pending threshold, so fast navigations never flash.
 */
export function PendingPage() {
  return (
    <div className="min-h-screen bg-paper">
      <main
        aria-busy="true"
        aria-label="Loading"
        className="mx-auto max-w-[42rem] px-6 py-16 md:py-24"
      >
        <div className="animate-pulse space-y-4 motion-reduce:animate-none">
          <div className="h-8 w-2/3 rounded-none bg-rule/70" />
          <div className="h-4 w-1/3 bg-rule/50" />
          <div className="space-y-3 pt-10">
            <div className="h-4 w-full bg-rule/50" />
            <div className="h-4 w-11/12 bg-rule/50" />
            <div className="h-4 w-full bg-rule/50" />
            <div className="h-4 w-4/5 bg-rule/50" />
          </div>
        </div>
        <p className="sr-only">Loading…</p>
      </main>
    </div>
  );
}
