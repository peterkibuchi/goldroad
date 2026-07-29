/**
 * Goldroad chrome — Pressroom register: Franklin display type, ink rules,
 * double-rule masthead, one vermillion accent moment per view.
 *
 * Two frames live here, chosen by `AppShell`'s `header.variant`:
 *  - marketing / signed-out: the original top bar (`SiteHeader` + content +
 *    `SiteFooter`) — unauthenticated surfaces stay exactly as they were.
 *  - signed-in: the command rail (`WriterChrome`) — chosen over a fourth
 *    top-bar iteration because it scales past four destinations without a
 *    redesign (DECISIONS #62). A slim left rail carries icon+label nav with
 *    identity pinned at the bottom (the native-app account-switcher spot);
 *    content gets the full width writing surfaces want. Below ~760px the
 *    rail can't survive — it collapses to a slim top strip (wordmark +
 *    public-page/sign-out) plus a bottom tab bar (icons only, real
 *    destinations only — the mobile-native pattern for this exact job).
 *    Two dimmed "Soon" rows (Stats, Newsletter) are folded in from chrome
 *    direction 03 — non-interactive, so future surfaces don't force another
 *    chrome rework later. Both frames read the same design tokens; reading
 *    surfaces (see ~/components/document-article) never render either one.
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

export type WriterNavItem = "write" | "import" | "posts" | "settings";

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
   * deliberately (chrome direction 02's honest mobile-story constraint). */
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
          // Marketing header carries no sign-in link for now (pre-launch —
          // see DESIGN.md's founding-writers stance).
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
  {
    item: "settings",
    href: "/settings",
    label: "Settings",
    Icon: IconSettings,
  },
];

/** Visible growth promises, not live routes — chrome direction 03's
 * dimmed-"Soon" pattern folded into the rail (DECISIONS #62) so shipping
 * Stats/Newsletter later never forces another chrome redesign. Rendered as
 * inert `<span>` rows, never `<a>` — there is nowhere for them to go yet, and
 * a fake `href="#"` would be dishonest to assistive tech and keyboard users. */
const SOON_NAV: ReadonlyArray<{ label: string; Icon: NavIcon }> = [
  { label: "Stats", Icon: IconChartBar },
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
        "flex min-h-11 items-center gap-3 border-transparent border-l-3 px-4 py-2 font-display text-sm transition-colors",
        isActive
          ? "border-spot bg-ink/5 font-bold text-ink"
          : "text-ink-soft hover:bg-ink/5 hover:text-ink",
      )}
      href={href}
    >
      <Icon aria-hidden="true" className="shrink-0" size={19} stroke={1.75} />
      {label}
    </a>
  );
}

function SoonRow({ label, Icon }: { label: string; Icon: NavIcon }) {
  return (
    <span className="flex min-h-11 items-center gap-3 border-transparent border-l-3 px-4 py-2 font-display text-ink-soft text-sm opacity-60">
      <Icon aria-hidden="true" className="shrink-0" size={19} stroke={1.75} />
      {label}
      <span className="ml-auto border border-ink-soft border-dashed px-1.5 py-0.5 font-semibold text-[0.6rem] uppercase tracking-[0.1em]">
        Soon
      </span>
    </span>
  );
}

function initialOf(ident: string): string {
  return (ident.trim().charAt(0) || "?").toUpperCase();
}

/** Bottom-of-rail identity cluster — where every native app puts account
 * switching. Carries the two links the mobile frame moves into the top
 * strip: the writer's public page and sign out. */
function RailIdentity({ ident }: { ident: string }) {
  return (
    <div className="mt-auto flex items-center gap-2.5 border-rule border-t px-4 py-3">
      <span
        aria-hidden="true"
        className="flex size-7 shrink-0 items-center justify-center rounded-full bg-ink font-bold font-display text-paper text-xs"
      >
        {initialOf(ident)}
      </span>
      <span className="min-w-0">
        <span
          className="block truncate font-display font-semibold text-ink text-sm"
          title="Signed in with your own atproto identity"
        >
          {ident}
        </span>
        <span className="flex gap-3">
          <a
            className="font-display text-ink-soft text-xs underline underline-offset-2 transition-colors hover:text-ink"
            href={`/@${encodeURIComponent(ident)}`}
          >
            Public page
          </a>
          <form action="/logout" method="post">
            <button
              className="cursor-pointer font-display text-ink-soft text-xs underline underline-offset-2 transition-colors hover:text-ink"
              type="submit"
            >
              Sign out
            </button>
          </form>
        </span>
      </span>
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
    <aside className="hidden w-56 shrink-0 flex-col border-ink border-r-3 border-double md:flex">
      <div className="px-4 pt-4 pb-2">
        <Wordmark href="/dashboard" />
      </div>
      <nav aria-label="Writer" className="mt-2 flex flex-col">
        {WRITER_NAV.map(({ item, href, label, Icon }) => (
          <RailLink
            Icon={Icon}
            href={href}
            isActive={active === item}
            key={item}
            label={label}
          />
        ))}
        {SOON_NAV.map(({ label, Icon }) => (
          <SoonRow Icon={Icon} key={label} label={label} />
        ))}
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
      <Wordmark href="/dashboard" showBeta={false} />
      <span className="flex items-center gap-3 font-display text-ink-soft text-xs">
        <a
          className="underline underline-offset-2 transition-colors hover:text-ink"
          href={`/@${encodeURIComponent(ident)}`}
        >
          Public page
        </a>
        <form action="/logout" method="post">
          <button
            className="cursor-pointer underline underline-offset-2 transition-colors hover:text-ink"
            type="submit"
          >
            Sign out
          </button>
        </form>
      </span>
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
      className="fixed inset-x-0 bottom-0 z-10 flex border-ink border-t-3 border-double bg-paper md:hidden"
    >
      {WRITER_NAV.map(({ item, href, label, Icon }) => {
        const isActive = active === item;
        return (
          <a
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "flex min-h-11 flex-1 flex-col items-center gap-0.5 border-transparent border-t-2 px-1 py-2 font-display font-semibold text-[0.68rem]",
              isActive ? "border-spot text-ink" : "text-ink-soft",
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
        {/* Bottom padding on mobile clears the fixed tab bar; the rail
            layout needs none — it isn't fixed/floating. */}
        <div className="flex-1 pb-16 md:pb-0">{children}</div>
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
