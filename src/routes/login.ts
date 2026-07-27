import { createFileRoute } from "@tanstack/react-router";

import { isHandle } from "~/lib/atproto";
import { createOAuthClient, safeReturnTo } from "~/lib/oauth";

/**
 * A sign-in that can't start is a designed moment, not a bare 400 (the owner
 * hit the plain-text one in prod): 303 back to the /write sign-in panel,
 * which renders these codes as inline notices. The entered handle rides
 * along so the writer fixes the typo instead of retyping it.
 */
function backToSignIn(
  error: "invalid_handle" | "handle_not_found",
  handle: string,
): Response {
  const params = new URLSearchParams({ error });
  // 253 = the handle grammar's length cap: longer junk gets clipped, not echoed.
  params.set("handle", handle.slice(0, 253));
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
 * this is the side-effecting path (audit #8): a D1 write + a PAR push to an
 * attacker-named PDS must never ride on an unauthenticated GET.
 */
async function startLogin(
  request: Request,
  handle: string,
  returnTo: string,
): Promise<Response> {
  const trimmed = normalizeHandle(handle);
  // Nothing entered: the sign-in panel itself is the answer — no error yet.
  if (trimmed === "") return seeOther("/write");
  if (!isHandle(trimmed)) return backToSignIn("invalid_handle", trimmed);
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
    // Well-formed handle that wouldn't resolve (typo'd name, dead server,
    // network flake) — same designed path, different copy.
    console.error("authorize failed", err);
    return backToSignIn("handle_not_found", trimmed);
  }
}

export const Route = createFileRoute("/login")({
  server: {
    handlers: {
      // GET is READ-ONLY (audit #8): it never resolves a handle, writes a D1
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
