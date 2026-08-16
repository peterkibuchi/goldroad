import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { useState } from "react";

/**
 * A router context for components that render a `<Link>`.
 *
 * `RouterContextProvider` is the low-level half of `RouterProvider`: it puts a
 * router in React context WITHOUT rendering the matched route, which is exactly
 * what a component test wants — the component under test is already being
 * rendered by the test, and mounting the real route would drag its loader and
 * its server functions along with it.
 *
 * The tree is a stub, not the app's: a `Link`'s `to` is resolved against the
 * router it can see, so the routes a test's links point at have to exist here.
 * Add paths as tests need them.
 */
const rootRoute = createRootRoute();
const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: "/dashboard" }),
]);

export function TestRouter({
  children,
  path = "/",
}: {
  children: React.ReactNode;
  /** The location the links are rendered at — a relative search update
   * (`search: (prev) => …`) reads from it. */
  path?: string;
}) {
  // Once per mount: a fresh router on every render would throw away the
  // location a rerender-based test just navigated to.
  const [router] = useState(() =>
    createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: [path] }),
    }),
  );
  return (
    <RouterContextProvider router={router}>{children}</RouterContextProvider>
  );
}
