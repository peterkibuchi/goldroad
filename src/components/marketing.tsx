/**
 * Marketing primitives — Pressroom register: ink on paper, one vermillion
 * spot, Libre Franklin display, registration marks, double rules, zero
 * radius. Shared by the homepage and /leaving-substack so the two marketing
 * surfaces read as one system.
 *
 * The Pressroom VISUAL system stays; the press *metaphor* stays out of the
 * words (copy is plain and outcome-first, at most one subtle printing-trade
 * flourish per page). Voice lives in each page's copy, not here.
 */
import { cn } from "~/lib/utils";

/** Printer's registration mark — Pressroom garnish, marketing surfaces only. */
export function RegMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      viewBox="0 0 22 22"
    >
      <line stroke="currentColor" x1="11" x2="11" y1="0" y2="22" />
      <line stroke="currentColor" x1="0" x2="22" y1="11" y2="11" />
      <circle cx="11" cy="11" r="5.5" stroke="currentColor" />
    </svg>
  );
}

/** Section eyebrow — the page's scarce spot color, used small. */
export function Kicker({ children }: { children: React.ReactNode }) {
  return (
    <p className="font-display font-semibold text-spot text-xs uppercase tracking-[0.14em]">
      {children}
    </p>
  );
}

/** Primary action, one per section: vermillion fill, ink on hover. */
export function CtaLink({
  children,
  className,
  ...props
}: React.ComponentPropsWithoutRef<"a">) {
  return (
    <a
      className={cn(
        "inline-flex min-h-11 items-center justify-center bg-spot px-6 py-2.5 font-bold font-display text-base text-paper transition-colors hover:bg-ink",
        className,
      )}
      {...props}
    >
      {children}
    </a>
  );
}

/** The section's secondary path — an underlined text link, quiet next to the CTA. */
export function QuietLink({
  children,
  className,
  ...props
}: React.ComponentPropsWithoutRef<"a">) {
  return (
    <a
      className={cn(
        "inline-flex min-h-11 items-center font-display font-semibold text-ink text-sm underline decoration-2 underline-offset-4 transition-colors hover:text-spot",
        className,
      )}
      {...props}
    >
      {children}
    </a>
  );
}

/**
 * A page section with a contained inner column aligned to the site chrome
 * (max-w-5xl). `divider` draws the double ink rule that separates Pressroom
 * sections; the hero opts out and carries registration marks instead.
 */
export function MarketingSection({
  children,
  className,
  divider = false,
  ...props
}: React.ComponentPropsWithoutRef<"section"> & { divider?: boolean }) {
  return (
    <section
      className={cn(
        divider && "border-ink border-t-3 border-double",
        className,
      )}
      {...props}
    >
      <div className="mx-auto w-full max-w-5xl px-6 py-16 md:px-16 md:py-20">
        {children}
      </div>
    </section>
  );
}
