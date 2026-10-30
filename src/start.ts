/**
 * Start's own configuration. Without this file Start adds its CSRF middleware
 * for server functions by itself; with it, the middleware has to be listed
 * here, and it is, with the filter Start's default uses.
 *
 * The function middleware reports a server function that threw. Start turns
 * the throw into an error response, so `withExceptionCapture` in server.ts
 * never sees it: a D1 failure in a dashboard loader would leave no trace.
 */
import {
  createCsrfMiddleware,
  createMiddleware,
  createStart,
} from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

import { captureServerFnError } from "~/lib/error-tracking";

const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
});

const reportServerFnErrors = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    try {
      return await next();
    } catch (error) {
      captureServerFnError(error, getRequest());
      throw error;
    }
  },
);

export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware],
  functionMiddleware: [reportServerFnErrors],
}));
