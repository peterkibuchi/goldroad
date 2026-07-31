/**
 * The one seam between the route test suites and TanStack Start's route-options
 * shape.
 *
 * A file route's server handlers aren't reachable through the public `Route`
 * type, so every suite reached in with `Route.options as unknown as { server:
 * { handlers: … } }`. A DOUBLE cast is invisible to `tsc`: when `server.handlers`
 * moves — it is recent API on a fast-moving 1.x — typecheck stays green and a
 * dozen suites fail at runtime with `GET is not a function`, thirteen edits
 * away from the fix.
 *
 * Here the reach-in happens once, and the shape is checked at run time, so a
 * moved handler fails with a sentence naming what it looked for.
 */

/** A route server handler as the suites call it: give it a context, get a
 * response. The context defaults to just the request; routes with path params
 * pass their own shape. The real signature carries more; no suite uses it. */
export type RouteHandler<TCtx = { request: Request }> = (
  ctx: TCtx,
) => Promise<Response> | Response;

type WithHandlers = {
  options?: { server?: { handlers?: Record<string, unknown> } };
};

/**
 * The named server handler off a file route, or a thrown error saying which
 * one was missing and what was actually there.
 */
export function handlerOf<TCtx = { request: Request }>(
  route: unknown,
  method: string,
): RouteHandler<TCtx> {
  const handlers = (route as WithHandlers)?.options?.server?.handlers;
  const handler = handlers?.[method];
  if (typeof handler !== "function") {
    throw new Error(
      `route has no ${method} server handler (found: ${
        handlers ? Object.keys(handlers).join(", ") || "none" : "no handlers"
      }) — has TanStack Start's route-options shape moved?`,
    );
  }
  return handler as RouteHandler<TCtx>;
}
