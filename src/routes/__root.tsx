import { TanStackDevtools } from "@tanstack/react-devtools";
import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { useEffect } from "react";

import { env } from "#/env";
import { ErrorPage, NotFoundPage } from "~/components/system-pages";
import { APPEARANCE_KEY } from "~/lib/appearance";
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
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
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
const APPEARANCE_BOOTSTRAP = `(function(){try{var p=localStorage.getItem("${APPEARANCE_KEY}");var d=p==="dark"||(p!=="light"&&window.matchMedia("(prefers-color-scheme: dark)").matches);if(d)document.documentElement.dataset.theme="dark";}catch(e){}})();`;

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
