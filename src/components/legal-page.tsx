/**
 * Shared frame for the system/legal pages — /policies, /privacy, /terms.
 * Pressroom register — we're speaking AS Goldroad here, not rendering a
 * writer. Franklin display headings, ink on paper,
 * hairline rules; serif body for long-form readability. A DRAFT banner marks
 * pages still awaiting final legal review.
 */
import { AppShell } from "~/components/site-chrome";
import { MAIN_CONTENT_ID } from "~/components/skip-link";

export function LegalLayout({
  kicker,
  title,
  updated,
  draft = false,
  children,
}: {
  kicker: string;
  title: string;
  updated?: string;
  draft?: boolean;
  children: React.ReactNode;
}) {
  return (
    <AppShell header={{ variant: "signed-out" }}>
      <main
        className="mx-auto w-full max-w-2xl px-6 py-16 md:py-24"
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
      >
        <p className="font-display text-sm font-semibold tracking-[0.12em] text-ink-soft uppercase">
          {kicker}
        </p>
        <h1 className="mt-3 font-display text-3xl font-black tracking-tight text-balance text-ink md:text-4xl">
          {title}
        </h1>
        {updated && (
          <p className="mt-3 font-display text-sm text-ink-soft">
            Last updated {updated}
          </p>
        )}
        {draft && (
          <p
            className="mt-6 border-2 border-spot px-4 py-3 font-display text-sm text-spot"
            role="note"
          >
            DRAFT — under legal review, not yet in force. Published for
            transparency ahead of public launch; the binding version will
            replace it.
          </p>
        )}
        <div className="mt-8 font-body leading-relaxed text-ink">
          {children}
        </div>
      </main>
    </AppShell>
  );
}

export function LegalSection({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-10 first:mt-0">
      <h2 className="font-display text-xl font-bold tracking-tight text-ink">
        {heading}
      </h2>
      <div className="mt-3 space-y-3 text-ink-soft">{children}</div>
    </section>
  );
}

export function LegalList({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="ml-5 list-disc space-y-2 text-ink-soft marker:text-rule">
      {items.map((item, i) => (
        // Static, order-stable policy copy — index keys are correct here.
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed static list
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}
