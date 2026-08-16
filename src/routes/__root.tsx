import { TanStackDevtools } from "@tanstack/react-devtools";
import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { useEffect } from "react";

import { env } from "#/env";
import { ErrorPage, NotFoundPage } from "~/components/system-pages";
import { APPEARANCE_KEY } from "~/lib/appearance";
import { CANONICAL_ORIGIN } from "~/lib/origin";
import { initPostHog } from "~/lib/posthog";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      {
        title: env.VITE_APP_TITLE ?? "Goldroad",
      },
      // The default social card, inherited by every page that does not set its
      // own. Without og:image a shared link renders as a bare text card on
      // Bluesky, X, LinkedIn, Slack and iMessage — which would have made every
      // launch post a live demonstration of the opposite of the pitch, since
      // the landing hero argues that Goldroad posts arrive as rich cards rather
      // than naked links. twitter:card is separate on purpose: X reads og: tags
      // for the title and description but needs this one for the card TYPE, and
      // its default is a small square thumbnail.
      { property: "og:site_name", content: "Goldroad" },
      // Only the image itself is defaulted here. Dimensions and alt text
      // deliberately are NOT: a page that supplies its own og:image — a post
      // with a cover — overrides this tag but cannot remove sibling ones, so
      // inherited width/height/alt would describe the wrong picture and the alt
      // would announce Goldroad on somebody's essay. Whoever knows the image
      // describes it; see the marketing pages and the document head.
      { property: "og:image", content: `${CANONICAL_ORIGIN}/og.png` },
      { name: "twitter:card", content: "summary_large_image" },
      // Status-bar and splash colour, per edition. iOS 26 opens ANY site added
      // to the Home Screen as a standalone app by default — with or without a
      // manifest — so a reader who saved us before this existed got a chromeless
      // window themed black by a Create-React-App default nobody chose. These
      // two make that window ours: paper in the light edition, the black-stock
      // near-black in the dark one, matching the palette in styles.css.
      {
        name: "theme-color",
        media: "(prefers-color-scheme: light)",
        content: "#ffffff",
      },
      {
        name: "theme-color",
        media: "(prefers-color-scheme: dark)",
        content: "#1a1815",
      },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      { rel: "manifest", href: "/manifest.json" },
      // iOS ignores the manifest's icons for the Home Screen and looks for
      // this. 180×180 is the size it actually wants (the 192 it was pointed at
      // is the Android number), and it is flattened onto the manifest's own
      // background: iOS composites transparency onto black.
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
    ],
  }),
  notFoundComponent: NotFoundPage,
  errorComponent: ErrorPage,
  shellComponent: RootDocument,
});

/**
 * Sets `data-theme="dark"` on <html> before anything renders, so a writer who
 * chose the dark edition never sees a flash of the light one. Kept tiny and
 * dependency-free because it blocks paint by design.
 *
 * Every surface Goldroad owns reads this (see the `.goldroad-surface` scope in
 * styles.css). Publication reading pages deliberately do not — a writer's page
 * follows the appearance they give it, not a reader's toggle.
 */
/**
 * Two attributes, and the difference between them is a product rule.
 *
 * `data-theme` is which edition to paint. `data-reader-edition` is present only
 * when the reader CHOSE one explicitly, and it is what lets that choice
 * override an author's theme.
 *
 * Following the system is not an opinion about somebody else's page; picking
 * light or dark by hand is a statement about how you need to read. So a stored
 * value overrides a writer's theme and an absent one does not — which keeps
 * theming working by default for everyone who never touches the control, while
 * never trapping a light-sensitive reader inside a white page.
 */
const APPEARANCE_BOOTSTRAP = `(function(){try{var p=localStorage.getItem("${APPEARANCE_KEY}");var e=document.documentElement;if(p==="dark"||p==="light")e.dataset.readerEdition=p;var d=p==="dark"||(p!=="light"&&window.matchMedia("(prefers-color-scheme: dark)").matches);if(d)e.dataset.theme="dark";}catch(e){}})();`;

function RootDocument({ children }: { children: React.ReactNode }) {
  // Cookieless analytics; a no-op unless VITE_PUBLIC_POSTHOG_KEY is set.
  useEffect(() => {
    initPostHog();
  }, []);
  return (
    <html lang="en">
      <head>
        <HeadContent />
        {/* Appearance, resolved BEFORE first paint.
            No cookie, deliberately: reading surfaces are edge-cached and
            cookie-independent, and a theme cookie would fragment that cache
            for every visitor. Reading the preference from localStorage in a
            blocking inline script keeps the cache whole and still avoids a
            flash of the wrong edition. "system" (the default) simply leaves
            the attribute unset and lets the media query decide. */}
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: a static, self-authored string with no interpolation — this must run before paint
          dangerouslySetInnerHTML={{ __html: APPEARANCE_BOOTSTRAP }}
        />
      </head>
      <body>
        {children}
        <TanStackDevtools
          config={{
            position: "bottom-right",
          }}
          plugins={[
            {
              name: "Tanstack Router",
              render: <TanStackRouterDevtoolsPanel />,
            },
          ]}
        />
        <Scripts />
      </body>
    </html>
  );
}
