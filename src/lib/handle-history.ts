/**
 * Old handles, so old links keep working. Publication and post URLs are built
 * from the writer's handle (`/@alice.example/<rkey>`), and those URLs end up
 * in records, Bluesky cards and feeds we can't rewrite. When the writer moves
 * to a new handle, the old one stops resolving; this remembers which DID it
 * belonged to, and the reading routes 301 to the writer's current address.
 *
 * Only handles that resolve back to the DID are recorded. A DID document's
 * handle claim is unverified, so recording it as-is would let anyone claim
 * `victim.example` in their own document and receive its stale links.
 */
import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { handleHistory } from "~/db/schema";
import {
  isHandle,
  resolveDidIdentity,
  resolveHandleToDid,
} from "~/lib/atproto";
import { env } from "cloudflare:workers";

type Db = ReturnType<typeof drizzle>;

/**
 * Remembers `handle` as `did`'s, if it really is. Costs one D1 read when the
 * row already matches, which is every publish but the first after a change.
 * Callers ignore failures: a missed row only costs a redirect later.
 */
export async function recordWriterHandle(
  db: Db,
  did: string,
  handle: string | null,
): Promise<void> {
  if (!handle || !isHandle(handle)) return;
  const key = handle.toLowerCase();
  const known = await db
    .select({ did: handleHistory.did })
    .from(handleHistory)
    .where(eq(handleHistory.handle, key))
    .get();
  if (known?.did === did) return;
  if ((await resolveHandleToDid(handle).catch(() => null)) !== did) return;
  await db
    .insert(handleHistory)
    .values({ handle: key, did, seenAt: new Date() })
    .onConflictDoUpdate({
      target: handleHistory.handle,
      set: { did, seenAt: new Date() },
    });
}

/** Where an old-handle link goes. `permanent` only when the destination is
 * the writer's verified current handle; a DID fallback may yet change. */
export type FormerHandleTarget = { ident: string; permanent: boolean };

/**
 * Where a link made with `handle` should go now, or null to leave it a 404.
 * Callers ask only after the handle itself failed to resolve. Null when we
 * never saw the handle, when the writer's DID document can't be read (an
 * outage must not mint a redirect), or when the writer still claims the
 * handle (so the failed resolution was something else).
 */
export async function formerHandleTarget(
  db: Db,
  handle: string,
): Promise<FormerHandleTarget | null> {
  const row = await db
    .select({ did: handleHistory.did })
    .from(handleHistory)
    .where(eq(handleHistory.handle, handle.toLowerCase()))
    .get();
  if (!row) return null;
  const { handle: current, pds } = await resolveDidIdentity(row.did);
  if (!current && !pds) return null;
  if (current?.toLowerCase() === handle.toLowerCase()) return null;
  if (
    current &&
    (await resolveHandleToDid(current).catch(() => null)) === row.did
  ) {
    // Remember the new handle too, so a second change doesn't strand links
    // that already followed this redirect.
    await db
      .insert(handleHistory)
      .values({
        handle: current.toLowerCase(),
        did: row.did,
        seenAt: new Date(),
      })
      .onConflictDoNothing()
      .catch(() => {});
    return { ident: current, permanent: true };
  }
  return { ident: row.did, permanent: false };
}

/** The redirect for a reader route: 301 to a verified handle, bounded so a
 * wrong one expires; 302 to a DID fallback. */
export function formerHandleRedirect(target: FormerHandleTarget, path: string) {
  return {
    href: `/@${encodeURIComponent(target.ident)}${path}`,
    statusCode: target.permanent ? 301 : 302,
    headers: {
      "cache-control": target.permanent ? "public, max-age=86400" : "no-store",
    },
  };
}

/** `formerHandleTarget` for the reader loaders, which also run in the
 * browser and so reach D1 through a server function. */
export const findFormerHandle = createServerFn({ method: "GET" })
  .validator((input: { handle: string }) => {
    if (!isHandle(input.handle)) throw new Error("not a handle");
    return { handle: input.handle };
  })
  .handler(async ({ data }) => {
    if (!env.DB) return null;
    return formerHandleTarget(drizzle(env.DB), data.handle).catch(
      (err: unknown) => {
        console.error("former-handle lookup failed", err);
        return null;
      },
    );
  });
