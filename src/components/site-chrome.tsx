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
 *    a bottom tab bar (destinations plus the center "New" slot — the
 *    mobile-native pattern for this exact job). A quiet "Soon" row
 *    (Newsletter) is folded in as a non-interactive promise, so shipping that
 *    surface later never forces another chrome rework — the same slot Stats
 *    graduated out of when it became a real destination. Both frames read the
 *    same design tokens; reading surfaces (see ~/components/document-article)
 *    never render either one.
 *
 * The rail is viewport-anchored, not document-anchored: `sticky top-0 h-dvh`
 * so navigation and identity stay put while the page scrolls beneath them.
 * The document keeps the only scrollbar — the rail's nav region is the single
 * place allowed to scroll, and only if its own rows ever outgrow the viewport.
 *
 * Navigation lists places; the primary action is a button. "New post" is not a
 * destination, so it sits above the nav landmark as the rail's one action and
 * carries the accent — the single amendment to "chrome spends no spot," argued
 * in full at `RailPrimaryAction`. Every navigation row stays ink.
 */
import {
  IconChartBar,
  IconHome,
  IconList,
  IconMail,
  IconPencil,
  type IconProps,
  IconSettings,
} from "@tabler/icons-react";
import type { ComponentType } from "react";

import { ExternalLink } from "~/components/external-link";
import { cn } from "~/lib/utils";

/**
 * The rail's destinations — places a writer can be, and nothing else.
 *
 * "Write" used to sit here as a peer of Posts and Settings, which answered
 * "where can I go" with "do something"; it is now the rail's primary action
 * (see `RailPrimaryAction`). Import left too: importing is a task you perform
 * on your archive roughly once, not a place you live, so it belongs in the
 * posts manager's toolbar. Surfaces that are an *act* rather than a place —
 * the editor, the importer — pass no `active` item at all.
 */
export type WriterNavItem = "home" | "posts" | "stats" | "settings";

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

/**
 * The source, the licence, the self-hosting path, and the network Goldroad
 * publishes into — one list, so the marketing footer, the app footer and
 * /open can never drift into disagreeing about where any of it lives.
 *
 * These are the claim the whole product rests on ("it cannot be taken away")
 * made checkable. Absent from the site, every other promise is just a
 * sentence.
 */
export const OPEN_LINKS = {
  repo: "https://github.com/peterkibuchi/goldroad",
  license: "https://github.com/peterkibuchi/goldroad/blob/main/LICENSE",
  selfHosting:
    "https://github.com/peterkibuchi/goldroad/blob/main/SELF_HOSTING.md",
  contributing:
    "https://github.com/peterkibuchi/goldroad/blob/main/CONTRIBUTING.md",
  atproto: "https://atproto.com",
} as const;

type FooterLink = { label: string; href: string; external?: boolean };

/** Marketing deck one. Three short columns, no logo wall — the "Open" column
 * is the reason-to-believe for everything the other two claim. */
const FOOTER_COLUMNS: ReadonlyArray<{
  heading: string;
  links: ReadonlyArray<FooterLink>;
}> = [
  {
    heading: "Product",
    links: [
      { href: "/leaving-substack", label: "Leaving Substack?" },
      { href: "/#join", label: "Founding writers" },
    ],
  },
  {
    heading: "Open",
    links: [
      { href: "/open", label: "What's open" },
      { external: true, href: OPEN_LINKS.repo, label: "Source on GitHub" },
      { external: true, href: OPEN_LINKS.license, label: "License: AGPL-3.0" },
      {
        external: true,
        href: OPEN_LINKS.selfHosting,
        label: "Run your own copy",
      },
      {
        external: true,
        href: OPEN_LINKS.atproto,
        label: "Built on the AT Protocol",
      },
    ],
  },
  {
    heading: "Legal",
    links: [
      { href: "/privacy", label: "Privacy" },
      { href: "/terms", label: "Terms" },
      { href: "/policies", label: "Policies" },
    ],
  },
];

/** App-surface band. Writers are the readers most likely to check the licence
 * claim, so it stays one click from every screen they work in. */
const COMPACT_LINKS: ReadonlyArray<FooterLink> = [
  { href: "/open", label: "Open source (AGPL)" },
  { external: true, href: OPEN_LINKS.repo, label: "GitHub" },
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/policies", label: "Policies" },
];

const FOOTER_LINK_CLASS = "transition-colors hover:text-ink";

function FooterLink({ label, href, external }: FooterLink) {
  if (external) {
    return (
      <ExternalLink className={FOOTER_LINK_CLASS} href={href}>
        {label}
      </ExternalLink>
    );
  }
  return (
    <a className={FOOTER_LINK_CLASS} href={href}>
      {label}
    </a>
  );
}

/** Deck two on marketing, and the whole footer everywhere else: the tagline,
 * the links, and the promise the product is named for. */
function FooterBand({ links }: { links?: ReadonlyArray<FooterLink> }) {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-wrap items-baseline justify-between gap-x-6 gap-y-2 px-6 py-5 font-display text-ink-soft text-xs md:px-16">
      <span>Goldroad — writer-owned publishing on the open network</span>
      {links && (
        <nav aria-label="Footer" className="flex flex-wrap gap-x-4 gap-y-1">
          {links.map((link) => (
            <FooterLink key={link.href} {...link} />
          ))}
        </nav>
      )}
      <span>Leave anytime. Lose nothing.</span>
    </div>
  );
}

/**
 * Pressroom footer, two shapes.
 *
 * `marketing` (/, /leaving-substack, /open) gets both decks: three labelled
 * columns over the closing band. Every other chrome-bearing surface gets the
 * single band with the same open-source items inline — enough to be one click
 * from the source and the licence on every screen, without turning app chrome
 * into a sitemap. Reading surfaces render neither (two-surface rule); their
 * printer's mark lives in `document-article.tsx`.
 */
export function SiteFooter({
  variant = "app",
}: {
  variant?: "marketing" | "app";
} = {}) {
  if (variant === "app") {
    return (
      <footer className="border-rule border-t">
        <FooterBand links={COMPACT_LINKS} />
      </footer>
    );
  }
  return (
    <footer className="border-ink border-t-3 border-double">
      <div className="mx-auto w-full max-w-5xl px-6 pt-10 pb-2 md:px-16">
        <div className="grid grid-cols-2 gap-x-8 gap-y-8 sm:grid-cols-3">
          {FOOTER_COLUMNS.map(({ heading, links }) => (
            <div key={heading}>
              {/* A label, not a heading: the nav landmark below already
                  carries the group name for assistive tech, and three <h2>s
                  in the footer would sit as peers of the page's own sections
                  in the heading outline. */}
              <p className="font-bold font-display text-ink text-xs uppercase tracking-[0.14em]">
                {heading}
              </p>
              <nav
                aria-label={heading}
                className="mt-3 flex flex-col items-start gap-y-2 font-display text-ink-soft text-sm"
              >
                {links.map((link) => (
                  <FooterLink key={link.href} {...link} />
                ))}
              </nav>
            </div>
          ))}
        </div>
      </div>
      {/* Hairline between the decks: the columns are structure, the closing
          line is a signature — they shouldn't read as one block. */}
      <div className="mt-8 border-rule border-t">
        <FooterBand />
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
  // Home is an explicit row, not a secret behind the wordmark: "click the logo"
  // is a convention designers know and writers don't.
  { item: "home", href: "/home", label: "Home", Icon: IconHome },
  { item: "posts", href: "/dashboard", label: "Posts", Icon: IconList },
  { item: "stats", href: "/stats", label: "Stats", Icon: IconChartBar },
  {
    item: "settings",
    href: "/settings",
    label: "Settings",
    Icon: IconSettings,
  },
];

/** The writer's one primary act, reachable from every surface they work in. */
const NEW_POST = { href: "/write", label: "New post", Icon: IconPencil };

/**
 * Mobile tab order: Home · Posts · New · Stats · Settings — the primary action
 * in the center slot, the one native pattern for exactly this job. A `null`
 * item marks the action: it is not a destination, so it can never be the
 * active row, and the label shortens to "New" where a tab is four characters
 * wide (its accessible name stays "New post").
 */
const MOBILE_TABS: ReadonlyArray<{
  item: WriterNavItem | null;
  href: string;
  label: string;
  Icon: NavIcon;
}> = [
  ...WRITER_NAV.slice(0, 2),
  { item: null, href: NEW_POST.href, label: "New", Icon: NEW_POST.Icon },
  ...WRITER_NAV.slice(2),
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

/**
 * The rail's primary action: full-width, directly under the wordmark, above
 * the nav landmark — a button, not a row, because it does something rather
 * than going somewhere. It is a link (it navigates to the editor), styled to
 * read as the action it is.
 *
 * ACCENT BUDGET, AMENDED ON PURPOSE. The house rule is "chrome spends no spot
 * color" (see docs/DESIGN.md); this one element breaks it. The rule's intent
 * was ever only "one vermillion moment per view", and making that moment the
 * *same* moment on every writer surface is the strongest reading of it: the
 * writer's single most important act finally wears the product's single
 * accent, in the same place, always. The consequence is paid honestly on the
 * pages — page-level spot primaries demote (the overview's next action goes to
 * the ink vocabulary, the posts manager's own "New post" is gone, the rail
 * carries it), so no writer view shows two accents.
 *
 * FALLBACK, STATED UP FRONT: if this reads loud across /home, /stats and
 * /settings once it is on screen, the button goes `bg-ink` (hover to spot,
 * matching the empty-state vocabulary) and the pages take their spot
 * primaries back. That is a one-line change here plus reverting the page
 * demotions — nothing downstream depends on which way it lands.
 *
 * Every navigation row stays ink either way: the active-section marker is a
 * solid ink rule, never the accent.
 */
function RailPrimaryAction() {
  return (
    <a
      className="flex min-h-11 w-full items-center justify-center gap-2 bg-spot px-4 font-bold font-display text-base text-paper transition-colors hover:bg-ink"
      href={NEW_POST.href}
    >
      <NEW_POST.Icon
        aria-hidden="true"
        className="shrink-0"
        size={18}
        stroke={2}
      />
      {NEW_POST.label}
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
        {/* The wordmark still goes home — but it's no longer the only way
            there: Home is a nav row now. */}
        <Wordmark href="/home" />
        <div className="mt-3">
          <RailPrimaryAction />
        </div>
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

/**
 * Bottom tab bar replacing the rail below ~760px — the mobile-native pattern
 * for this exact job. Real destinations plus the center "New" slot; "Soon"
 * rows stay a desktop-rail-only promise, not clutter on a screen this narrow.
 *
 * The action rides *inside* this landmark rather than above it, unlike the
 * desktop rail: at this width the tab bar is the entire chrome, and the native
 * convention writers already know puts the compose button in the middle of the
 * bar. Splitting it out would buy semantic tidiness at the cost of the one
 * shape every phone user can already operate.
 */
function WriterTabBar({ active }: { active?: WriterNavItem }) {
  return (
    <nav
      aria-label="Writer"
      // Safe-area padding keeps the tabs clear of a phone's home indicator.
      className="fixed inset-x-0 bottom-0 z-10 flex border-ink border-t-3 border-double bg-paper pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {MOBILE_TABS.map(({ item, href, label, Icon }) => {
        const isAction = item === null;
        const isActive = item !== null && active === item;
        return (
          <a
            aria-current={isActive ? "page" : undefined}
            aria-label={isAction ? NEW_POST.label : undefined}
            className={cn(
              // Same active vocabulary as the rail: a solid ink rule on the
              // leading edge. The accent is spent once, on the action.
              "flex min-h-11 flex-1 flex-col items-center gap-0.5 border-transparent border-t-2 px-1 py-2 font-display font-semibold text-[0.68rem] focus-visible:-outline-offset-2",
              isAction && "bg-spot font-bold text-paper",
              !isAction &&
                (isActive ? "border-ink font-bold text-ink" : "text-ink-soft"),
            )}
            href={href}
            key={item ?? "new"}
          >
            <Icon aria-hidden="true" size={20} stroke={isAction ? 2 : 1.75} />
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
      <SiteFooter
        variant={header.variant === "marketing" ? "marketing" : "app"}
      />
    </div>
  );
}
