/**
 * Goldroad chrome — Pressroom register: Franklin display type, ink rules,
 * double-rule masthead, one vermillion accent moment per view.
 *
 * Two frames live here, chosen by `AppShell`'s `header.variant`:
 *  - marketing / signed-out: the original top bar (`SiteHeader` + content +
 *    `SiteFooter`) — unauthenticated surfaces stay exactly as they were.
 *  - signed-in: the command rail (`WriterChrome`) — chosen over a fourth
 *    top-bar iteration because it scales past four destinations without a
 *    redesign. A slim left rail carries icon+label nav with identity pinned
 *    at the bottom (the native-app account-switcher spot); content gets the
 *    full width writing surfaces want. Below ~760px the rail can't survive —
 *    it collapses to a slim top strip (wordmark + public-page/sign-out) plus
 *    a bottom tab bar (icons only, real destinations only — the mobile-native
 *    pattern for this exact job). A quiet "Soon" row (Newsletter) is folded in
 *    as a non-interactive promise, so shipping that surface later never forces
 *    another chrome rework — the same slot Stats graduated out of when it
 *    became a real destination. Both frames read the same
 *    design tokens; reading surfaces (see ~/components/document-article)
 *    never render either one.
 *
 * The rail is viewport-anchored, not document-anchored: `sticky top-0 h-dvh`
 * so navigation and identity stay put while the page scrolls beneath them.
 * The document keeps the only scrollbar — the rail's nav region is the single
 * place allowed to scroll, and only if its own rows ever outgrow the viewport.
 *
 * Chrome deliberately spends no spot color: the vermillion accent is scarce
 * (one moment per view) and belongs to the page's primary action, so the
 * active-section marker is a solid ink rule instead.
 */
import {
  IconChartBar,
  IconFileImport,
  IconList,
  IconMail,
  IconPencil,
  type IconProps,
  IconSettings,
} from "@tabler/icons-react";
import type { ComponentType } from "react";

import { cn } from "~/lib/utils";

export type WriterNavItem = "write" | "import" | "posts" | "stats" | "settings";

type MarketingHeaderProps =
  /** Marketing surfaces — wordmark home, waitlist-era status, sign-in path. */
  | { variant: "marketing" }
  /** Signed-out product surfaces (sign-in page, 404, errors). */
  | { variant: "signed-out" };

/** The full set AppShell accepts — signed-in surfaces get the rail instead
 * of this file's top bar. */
type AppShellHeaderProps =
  | MarketingHeaderProps
  | { variant: "signed-in"; ident: string; active?: WriterNavItem };

function Wordmark({
  href,
  showBeta = true,
}: {
  href: string;
  /** The mobile top strip drops the chip first when space is tight —
   * deliberately — on a narrow strip the wordmark itself has to win. */
  showBeta?: boolean;
}) {
  return (
    <a
      className="inline-flex min-h-11 items-center gap-2 font-black font-display text-ink text-lg tracking-tight"
      href={href}
    >
      <span>
        Goldroad<span className="text-spot">.</span>
      </span>
      {showBeta && (
        // Product-phase label, not infrastructure: remove this one element
        // at GA — releases keep flowing through the same channels regardless.
        <span className="border border-ink-soft px-1.5 py-0.5 font-semibold text-[0.6rem] text-ink-soft uppercase tracking-[0.12em]">
          beta
        </span>
      )}
    </a>
  );
}

/** Marketing / signed-out top bar. Signed-in surfaces use `WriterChrome`
 * (below) instead — see AppShell. */
export function SiteHeader(props: MarketingHeaderProps) {
  return (
    <header className="border-ink border-b-3 border-double">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-6 px-6 py-2 md:px-16">
        <Wordmark href="/" />
        {props.variant === "marketing" && (
          // Marketing header carries no sign-in link while the product is
          // still opening to its first writers by invitation.
          <span className="ml-auto font-display font-semibold text-ink-soft text-sm">
            Opening soon
          </span>
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

type NavIcon = ComponentType<IconProps>;

const WRITER_NAV: ReadonlyArray<{
  item: WriterNavItem;
  href: string;
  label: string;
  Icon: NavIcon;
}> = [
  { item: "write", href: "/write", label: "Write", Icon: IconPencil },
  { item: "import", href: "/import", label: "Import", Icon: IconFileImport },
  { item: "posts", href: "/dashboard", label: "Posts", Icon: IconList },
  { item: "stats", href: "/stats", label: "Stats", Icon: IconChartBar },
  {
    item: "settings",
    href: "/settings",
    label: "Settings",
    Icon: IconSettings,
  },
];

/** Visible growth promises, not live routes, so shipping a new destination
 * never forces another chrome redesign. Rendered as inert `<span>` rows, never
 * `<a>` — there is nowhere for them to go yet, and a fake `href="#"` would be
 * dishonest to assistive tech and keyboard users. */
const SOON_NAV: ReadonlyArray<{ label: string; Icon: NavIcon }> = [
  { label: "Newsletter", Icon: IconMail },
];

function RailLink({
  href,
  label,
  Icon,
  isActive,
}: {
  href: string;
  label: string;
  Icon: NavIcon;
  isActive: boolean;
}) {
  return (
    <a
      aria-current={isActive ? "page" : undefined}
      className={cn(
        // Rows are full-bleed inside a scrollable nav, so the focus ring is
        // inset — an outset one would be clipped by the scroll container.
        "flex min-h-11 items-center gap-3 border-transparent border-l-2 px-4 py-2 font-display text-sm transition-colors focus-visible:-outline-offset-2",
        isActive
          ? "border-ink bg-ink/5 font-bold text-ink"
          : "text-ink-soft hover:bg-ink/5 hover:text-ink",
      )}
      href={href}
    >
      <Icon aria-hidden="true" className="shrink-0" size={19} stroke={1.75} />
      {label}
    </a>
  );
}

/** An unavailable destination has to read as *not yet*, never as broken: full
 * ink-soft (dimming it below that failed contrast), matched to the rail's live
 * rows, with the chip and the absence of any hover response carrying the
 * "unavailable" message instead. */
function SoonRow({ label, Icon }: { label: string; Icon: NavIcon }) {
  return (
    <span className="flex min-h-11 items-center gap-3 border-transparent border-l-2 px-4 py-2 font-display text-ink-soft text-sm">
      <Icon aria-hidden="true" className="shrink-0" size={19} stroke={1.75} />
      {label}
      {/* Same hairline chip as the wordmark's phase label — one chip
          convention in this chrome, not two. */}
      <span className="ml-auto border border-ink-soft px-1.5 py-0.5 font-semibold text-[0.6rem] uppercase tracking-[0.12em]">
        Soon
      </span>
    </span>
  );
}

function initialOf(ident: string): string {
  return (ident.trim().charAt(0) || "?").toUpperCase();
}

/** Bottom-of-rail identity cluster — where every native app puts account
 * switching. `mt-auto` inside the rail's full-height column pins it to the
 * bottom of the *viewport*, not the bottom of the document. Carries the two
 * links the mobile frame moves into the top strip: the writer's public page
 * and sign out. */
function RailIdentity({ ident }: { ident: string }) {
  return (
    <div className="mt-auto flex shrink-0 items-center gap-2.5 border-rule border-t px-4 py-3">
      {/* Square, not a circle: this register carries no rounded corners. */}
      <span
        aria-hidden="true"
        className="flex size-7 shrink-0 items-center justify-center bg-ink font-bold font-display text-paper text-xs"
      >
        {initialOf(ident)}
      </span>
      <div className="min-w-0 flex-1">
        {/* Long handles truncate; the title carries the full one, since a
            clipped handle is the one thing a writer needs to read in full. */}
        <span
          className="block truncate font-display font-semibold text-ink text-sm"
          title={ident}
        >
          {ident}
        </span>
        <div className="flex gap-3">
          <a
            className="inline-flex min-h-6 items-center font-display text-ink-soft text-xs underline underline-offset-2 transition-colors hover:text-ink"
            href={`/@${encodeURIComponent(ident)}`}
          >
            Public page
          </a>
          <form action="/logout" method="post">
            <button
              className="inline-flex min-h-6 cursor-pointer items-center font-display text-ink-soft text-xs underline underline-offset-2 transition-colors hover:text-ink"
              type="submit"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

function WriterRail({
  ident,
  active,
}: {
  ident: string;
  active?: WriterNavItem;
}) {
  return (
    // Viewport-anchored: sticky at the top of the scrollport and exactly one
    // viewport tall, so the rail holds still while the page scrolls past it.
    // `dvh` keeps the identity cluster on the visible edge on mobile browsers
    // whose toolbars make `vh` lie.
    <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col border-ink border-r-3 border-double md:flex">
      <div className="shrink-0 px-4 pt-4 pb-2">
        {/* The wordmark is home: for a signed-in writer that's the overview,
            not the posts manager. */}
        <Wordmark href="/home" />
      </div>
      {/* The one region permitted to scroll, and only when the rows genuinely
          outgrow the viewport — at these counts they never do, but a writer on
          a short window still reaches every destination. */}
      <nav
        aria-label="Writer"
        className="mt-2 flex min-h-0 flex-1 flex-col overflow-y-auto"
      >
        {WRITER_NAV.map(({ item, href, label, Icon }) => (
          <RailLink
            Icon={Icon}
            href={href}
            isActive={active === item}
            key={item}
            label={label}
          />
        ))}
        {/* A hairline separates what a writer can do now from what's coming,
            so the inert rows never read as live destinations that failed. */}
        <div className="mt-2 border-rule border-t pt-2">
          {SOON_NAV.map(({ label, Icon }) => (
            <SoonRow Icon={Icon} key={label} label={label} />
          ))}
        </div>
      </nav>
      <RailIdentity ident={ident} />
    </aside>
  );
}

/** Slim top strip replacing the rail below ~760px: wordmark (no beta chip —
 * the first casualty of tight space) plus the identity links the rail
 * carries at its foot on desktop. */
function WriterTopStrip({ ident }: { ident: string }) {
  return (
    <div className="flex items-center justify-between border-ink border-b-3 border-double px-4 py-2 md:hidden">
      <Wordmark href="/home" showBeta={false} />
      {/* Touch surface: these two get full-height hit areas, even though the
          text stays small. */}
      <div className="flex items-center gap-3 font-display text-ink-soft text-xs">
        <a
          className="inline-flex min-h-11 items-center underline underline-offset-2 transition-colors hover:text-ink"
          href={`/@${encodeURIComponent(ident)}`}
        >
          Public page
        </a>
        <form action="/logout" method="post">
          <button
            className="inline-flex min-h-11 cursor-pointer items-center underline underline-offset-2 transition-colors hover:text-ink"
            type="submit"
          >
            Sign out
          </button>
        </form>
      </div>
    </div>
  );
}

/** Bottom tab bar replacing the rail below ~760px — the mobile-native
 * pattern for this exact job. Real destinations only: "Soon" rows stay a
 * desktop-rail-only promise, not clutter on a screen this narrow. */
function WriterTabBar({ active }: { active?: WriterNavItem }) {
  return (
    <nav
      aria-label="Writer"
      // Safe-area padding keeps the tabs clear of a phone's home indicator.
      className="fixed inset-x-0 bottom-0 z-10 flex border-ink border-t-3 border-double bg-paper pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {WRITER_NAV.map(({ item, href, label, Icon }) => {
        const isActive = active === item;
        return (
          <a
            aria-current={isActive ? "page" : undefined}
            className={cn(
              // Same active vocabulary as the rail: a solid ink rule on the
              // leading edge, no spot color spent on chrome.
              "flex min-h-11 flex-1 flex-col items-center gap-0.5 border-transparent border-t-2 px-1 py-2 font-display font-semibold text-[0.68rem] focus-visible:-outline-offset-2",
              isActive ? "border-ink font-bold text-ink" : "text-ink-soft",
            )}
            href={href}
            key={item}
          >
            <Icon aria-hidden="true" size={20} stroke={1.75} />
            {label}
          </a>
        );
      })}
    </nav>
  );
}

/** The signed-in writer's frame: command rail on desktop, top strip + bottom
 * tab bar below ~760px. See the file header for the full rationale. */
function WriterChrome({
  ident,
  active,
  children,
}: {
  ident: string;
  active?: WriterNavItem;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-paper font-body text-ink md:flex-row">
      <WriterRail active={active} ident={ident} />
      <div className="flex min-w-0 flex-1 flex-col">
        <WriterTopStrip ident={ident} />
        {/* Bottom padding on mobile clears the fixed tab bar and the phone's
            home indicator below it; the rail needs none — it's sticky inside
            the flow, so it steals no space from the content column. */}
        <div className="flex-1 pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-0">
          {children}
        </div>
        <SiteFooter />
      </div>
      <WriterTabBar active={active} />
    </div>
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
  header: AppShellHeaderProps;
}) {
  if (header.variant === "signed-in") {
    return (
      <WriterChrome active={header.active} ident={header.ident}>
        {children}
      </WriterChrome>
    );
  }
  return (
    <div className="flex min-h-screen flex-col bg-paper font-body text-ink">
      <SiteHeader {...header} />
      <div className="flex-1">{children}</div>
      <SiteFooter />
    </div>
  );
}
