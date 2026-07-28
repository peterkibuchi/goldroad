/**
 * Goldroad chrome — Pressroom register: Franklin
 * display type, ink rules, double-rule masthead, one vermillion accent moment
 * per view. Marketing and writer surfaces share this shell; reading surfaces
 * never render it — the writer's identity dominates there (see
 * ~/components/document-article).
 */

export type WriterNavItem = "write" | "import" | "posts" | "settings";

type SiteHeaderProps =
  /** Marketing surfaces — wordmark home, waitlist-era status, sign-in path. */
  | { variant: "marketing" }
  /** Signed-out product surfaces (sign-in page, 404, errors). */
  | { variant: "signed-out" }
  /** Signed-in writer surfaces — full nav + identity + sign out. */
  | { variant: "signed-in"; ident: string; active?: WriterNavItem };

function Wordmark({ href }: { href: string }) {
  return (
    <a
      className="inline-flex min-h-11 items-center font-black font-display text-ink text-lg tracking-tight"
      href={href}
    >
      Goldroad<span className="text-spot">.</span>
    </a>
  );
}

function NavLink({
  href,
  label,
  isActive = false,
}: {
  href: string;
  label: string;
  isActive?: boolean;
}) {
  return (
    <a
      aria-current={isActive ? "page" : undefined}
      className={
        isActive
          ? "inline-flex min-h-11 items-center border-ink border-b-2 font-bold font-display text-ink text-sm"
          : "inline-flex min-h-11 items-center border-transparent border-b-2 font-display font-medium text-ink-soft text-sm transition-colors hover:text-ink"
      }
      href={href}
    >
      {label}
    </a>
  );
}

export function SiteHeader(props: SiteHeaderProps) {
  const signedIn = props.variant === "signed-in";
  return (
    <header className="border-ink border-b-3 border-double">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-6 px-6 py-2 md:px-16">
        <Wordmark href={signedIn ? "/dashboard" : "/"} />
        {signedIn ? (
          <>
            {/* No order-* utilities: DOM order must match visual order for a
                sane keyboard sequence — on narrow screens the nav simply
                wraps to its own row, sign-out to the row after. */}
            <nav
              aria-label="Writer"
              className="flex w-full flex-wrap items-center gap-x-5 md:w-auto"
            >
              <NavLink
                href="/write"
                isActive={props.active === "write"}
                label="Write"
              />
              <NavLink
                href="/import"
                isActive={props.active === "import"}
                label="Import"
              />
              <NavLink
                href="/dashboard"
                isActive={props.active === "posts"}
                label="Posts"
              />
              <NavLink
                href="/settings"
                isActive={props.active === "settings"}
                label="Settings"
              />
              <NavLink
                href={`/@${encodeURIComponent(props.ident)}`}
                label="Public page"
              />
            </nav>
            <span
              className="ml-auto hidden font-display text-ink-soft text-sm sm:inline"
              title="Signed in with your own atproto identity"
            >
              {props.ident}
            </span>
            <form action="/logout" className="ml-auto md:ml-0" method="post">
              <button
                className="inline-flex min-h-11 cursor-pointer items-center font-display text-ink-soft text-sm underline underline-offset-2 transition-colors hover:text-ink"
                type="submit"
              >
                Sign out
              </button>
            </form>
          </>
        ) : (
          // Marketing header carries no sign-in link for now.
          props.variant === "marketing" && (
            <span className="ml-auto font-display font-semibold text-ink-soft text-sm">
              Opening soon
            </span>
          )
        )}
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-rule border-t">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-baseline justify-between gap-x-6 gap-y-2 px-6 py-5 font-display text-ink-soft text-xs md:px-16">
        <span>Goldroad — writer-owned publishing on the open network</span>
        <nav aria-label="Legal" className="flex flex-wrap gap-x-4 gap-y-1">
          <a className="transition-colors hover:text-ink" href="/privacy">
            Privacy
          </a>
          <a className="transition-colors hover:text-ink" href="/terms">
            Terms
          </a>
          <a className="transition-colors hover:text-ink" href="/policies">
            Policies
          </a>
        </nav>
        <span>Leave anytime. Lose nothing.</span>
      </div>
    </footer>
  );
}

/**
 * Page frame for chrome-bearing surfaces: masthead, content well, footer.
 * Reading surfaces don't use this — they render bare (two-surface rule).
 */
export function AppShell({
  children,
  header,
}: {
  children: React.ReactNode;
  header: SiteHeaderProps;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-paper font-body text-ink">
      <SiteHeader {...header} />
      <div className="flex-1">{children}</div>
      <SiteFooter />
    </div>
  );
}
