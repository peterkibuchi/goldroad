import { OAuthResolverError } from "@atcute/oauth-node-client";
import { createFileRoute } from "@tanstack/react-router";

import { isHandle } from "~/lib/atproto";
import { createOAuthClient, safeReturnTo } from "~/lib/oauth";

/**
 * A sign-in that can't start is a designed moment, not a bare 400: a
 * text/plain 400 from this handler is a dead end in the browser — no way back
 * to the form, and the typed handle is lost. So every failure 303s back to the
 * /write sign-in panel, which renders these codes as inline notices, and the
 * entered handle rides along so the writer fixes the typo instead of retyping
 * it.
 */
function backToSignIn(
  error: "invalid_handle" | "handle_not_found" | "signin_unavailable",
  handle: string,
  returnTo?: string,
): Response {
  const params = new URLSearchParams({ error });
  // 253 = the handle grammar's length cap: longer junk gets clipped, not echoed.
  params.set("handle", handle.slice(0, 253));
  // Where the writer was headed survives the typo too. Without this, mistyping
  // a handle after being bounced here from /stats silently reroutes them: the
  // panel would re-post its own default instead of their destination.
  if (returnTo !== undefined) params.set("returnTo", returnTo);
  return new Response(null, {
    status: 303,
    headers: { location: `/write?${params}` },
  });
}

function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@/, "");
}

/**
 * Starts the OAuth flow: resolves the handle to its authorization server,
 * pushes the PAR request, and 302s the user to authorize. The state (with
 * returnTo) is persisted in the D1 state store by the library. POST-only —
 * this is the side-effecting path: a D1 write + a PAR push to an
 * attacker-named PDS must never ride on an unauthenticated GET.
 */
async function startLogin(
  request: Request,
  handle: string,
  returnTo: string,
): Promise<Response> {
  const trimmed = normalizeHandle(handle);
  // Guarded once, here, so every path below carries the same vetted value —
  // the state the PDS gets back, and the redirects that hand the writer back
  // to the sign-in panel. `undefined` = the form named nothing, so the panel
  // keeps its own default rather than being told one.
  const dest = returnTo === "" ? undefined : safeReturnTo(returnTo);
  // Nothing entered: the sign-in panel itself is the answer — no error yet.
  if (trimmed === "")
    return seeOther(
      dest ? `/write?returnTo=${encodeURIComponent(dest)}` : "/write",
    );
  if (!isHandle(trimmed)) return backToSignIn("invalid_handle", trimmed, dest);
  const client = createOAuthClient(new URL(request.url).origin);
  try {
    const { url } = await client.authorize({
      target: { type: "account", identifier: trimmed },
      state: { returnTo: safeReturnTo(returnTo) },
    });
    return new Response(null, {
      status: 302,
      headers: { location: url.toString() },
    });
  } catch (err) {
    console.error("authorize failed", err);
    // Two different failures hide in authorize(), and blaming the handle for
    // both misdirects the writer. OAuthResolverError is the library's wrapper
    // for every resolution miss on THEIR side of the fence — unknown handle,
    // dead DNS/.well-known, their PDS's metadata unreachable — so it keeps
    // the "check the handle" copy. Anything else (PAR push, client-assertion
    // keys, our D1 state store) is OUR infrastructure failing: say that, and
    // don't send the writer off to respell a handle that resolves fine.
    return backToSignIn(
      err instanceof OAuthResolverError
        ? "handle_not_found"
        : "signin_unavailable",
      trimmed,
      dest,
    );
  }
}

export const Route = createFileRoute("/login")({
  server: {
    handlers: {
      // GET is READ-ONLY: it never resolves a handle, writes a D1
      // state row, or pushes PAR. Malformed input still gets the designed
      // inline error (no side effect); a well-formed handle is prefilled back
      // into the /write sign-in form, which POSTs to actually start the flow.
      GET: ({ request }) => {
        const handle = normalizeHandle(
          new URL(request.url).searchParams.get("handle") ?? "",
        );
        if (handle === "") return seeOther("/write");
        if (!isHandle(handle)) return backToSignIn("invalid_handle", handle);
        const params = new URLSearchParams({ handle: handle.slice(0, 253) });
        return seeOther(`/write?${params}`);
      },
      POST: async ({ request }) => {
        const form = await request.formData().catch(() => null);
        if (!form) return new Response("Invalid form", { status: 400 });
        return startLogin(
          request,
          String(form.get("handle") ?? ""),
          String(form.get("returnTo") ?? ""),
        );
      },
    },
  },
});
