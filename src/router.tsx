import { createRouter as createTanStackRouter } from "@tanstack/react-router";

import { PendingPage } from "~/components/system-pages";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  const router = createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    // Loading policy: skeletons, never spinners. PDS roundtrips
    // make client-side navigations to reader/dashboard routes noticeably slow.
    defaultPendingComponent: PendingPage,
  });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
