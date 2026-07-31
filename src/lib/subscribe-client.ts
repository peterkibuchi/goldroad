/**
 * The reader's side of the subscribe wire — what the control calls, with no
 * React in it.
 *
 * Separate from `~/lib/subscription` on purpose. That module holds the record
 * shape and its guards and is imported by the write handler, which pulls the
 * lexicon runtime in with it; this one ships to the browser on every reading
 * page, and a reading page should carry the fetch and nothing else. The
 * validation those guards do is the SERVER'S job here anyway — both endpoints
 * run `isAtUri` on the publication before it reaches a record, and a client-side
 * copy would be a second home for a rule that only counts at the write door.
 *
 * Same shape as `uploadInlineImage` in ~/lib/inline-images: an injectable
 * `fetch`, a non-JSON answer treated as failure, and one place that maps a
 * server error code to what the reader should do about it.
 */

/**
 * The reader's relationship to a publication, as the control needs it.
 *
 * "unavailable" is a distinct state and not folded into `subscribed: false`:
 * they are opposite claims, and guessing wrong puts a Subscribe button in front
 * of a reader who already subscribed. The control renders nothing for it.
 */
export type SubscriptionState =
  | { status: "signed-out" }
  | { status: "known"; subscribed: boolean }
  | { status: "unavailable" };

/** GET /api/subscription — see the route for why this isn't in the loader. */
export async function readSubscriptionState(
  publicationAtUri: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SubscriptionState> {
  let res: Response;
  try {
    res = await fetchImpl(
      `/api/subscription?publication=${encodeURIComponent(publicationAtUri)}`,
    );
  } catch {
    return { status: "unavailable" };
  }
  const data = (await res.json().catch(() => null)) as {
    ok?: boolean;
    signedIn?: boolean;
    subscribed?: boolean;
  } | null;
  if (!res.ok || data?.ok !== true) return { status: "unavailable" };
  if (data.signedIn !== true) return { status: "signed-out" };
  // A missing or non-boolean `subscribed` from a signed-in answer is a shape we
  // don't understand, not a "no" — same reason as the type above.
  if (typeof data.subscribed !== "boolean") return { status: "unavailable" };
  return { status: "known", subscribed: data.subscribed };
}

/**
 * What a press did.
 *
 * `reconnect` means the reader has to sign in again before this can work, and it
 * covers two different server answers deliberately: a session that expired, and
 * a grant made before the subscription scope existed (see ~/lib/oauth-scopes —
 * those sessions can read but not write subscriptions). To the reader both are
 * one instruction, and neither may present as a button that quietly does
 * nothing.
 */
export type SubscriptionWrite =
  | { ok: true; subscribed: boolean }
  | { ok: false; reason: "reconnect" | "failed" };

/**
 * POST /api/publish — the single write path, `intent=subscribe`/`unsubscribe`.
 *
 * The form carries the publication and nothing else: no record key, because the
 * handler looks up the one it will delete rather than trusting a page with it.
 */
export async function writeSubscription(
  publicationAtUri: string,
  subscribe: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<SubscriptionWrite> {
  const form = new FormData();
  form.set("intent", subscribe ? "subscribe" : "unsubscribe");
  form.set("publication", publicationAtUri);
  let res: Response;
  try {
    res = await fetchImpl("/api/publish", { method: "POST", body: form });
  } catch {
    return { ok: false, reason: "failed" };
  }
  const data = (await res.json().catch(() => null)) as {
    ok?: boolean;
    subscribed?: boolean;
    error?: unknown;
  } | null;
  // 401 covers the plain-text "Not signed in" the handler answers before it
  // reads a body, as well as the JSON session_expired below it.
  if (
    res.status === 401 ||
    data?.error === "session_expired" ||
    data?.error === "subscription_scope"
  ) {
    return { ok: false, reason: "reconnect" };
  }
  if (!res.ok || data?.ok !== true || typeof data.subscribed !== "boolean") {
    return { ok: false, reason: "failed" };
  }
  return { ok: true, subscribed: data.subscribed };
}

/**
 * Where to send a reader who has to sign in — the app's one sign-in form, told
 * where they were.
 *
 * The path is taken verbatim, exactly as the writer surfaces take it: the single
 * open-redirect guard is `safeReturnTo` in ~/lib/oauth, and it runs on the POST
 * to /login where this value can actually become a `Location`. A second copy of
 * that check here would be a security rule with two homes, free to drift.
 */
export function signInHref(returnTo: string): string {
  return `/write?returnTo=${encodeURIComponent(returnTo)}`;
}
