/**
 * The reading page's door to ~/lib/recommendations: a server function, so the
 * takedown list (D1) is read on the server and the six publication reads run
 * there too, rather than in a reader's browser on a client-side navigation.
 */
import { createServerFn } from "@tanstack/react-start";
import { drizzle } from "drizzle-orm/d1";

import { parseAtUri } from "~/lib/atproto";
import { hiddenSubjects } from "~/lib/moderation";
import {
  cleanRecommendationUris,
  type RecommendationCard,
  resolveRecommendations,
} from "~/lib/recommendations";
import { env } from "cloudflare:workers";

type DrizzleD1 = ReturnType<typeof drizzle>;

/**
 * The cards for a cleaned list, minus any whose publication or author is
 * taken down here. Fail-open on a D1 error, like every takedown read (see
 * ~/lib/moderation), so a store outage costs the check and not the list.
 */
export async function visibleRecommendationCards(
  db: DrizzleD1 | null,
  uris: readonly string[],
): Promise<RecommendationCard[]> {
  const subjects = uris.flatMap((uri) => {
    const parsed = parseAtUri(uri);
    return parsed ? [uri, parsed.did] : [];
  });
  const hidden =
    db && subjects.length > 0
      ? await hiddenSubjects(db, subjects).catch((err) => {
          console.error("recommendation takedown check failed", err);
          return new Set<string>();
        })
      : new Set<string>();
  const shown = uris.filter(
    (uri) => !hidden.has(uri) && !hidden.has(parseAtUri(uri)?.did ?? ""),
  );
  const cards = await resolveRecommendations(shown);
  return cards.filter((card): card is RecommendationCard => card !== null);
}

/** Input is one newline-joined string: a GET server function encodes its
 * input into the URL, where an array doesn't survive (see hiddenSubjectsFromInput). */
export const recommendationCards = createServerFn({ method: "GET" })
  .validator((data: { uris?: unknown }) =>
    cleanRecommendationUris(
      typeof data?.uris === "string" ? data.uris.split("\n") : [],
    ),
  )
  // The binding is read inside the handler only, so the client build, which
  // drops the handler, never sees `cloudflare:workers`.
  .handler(({ data }) =>
    visibleRecommendationCards(env.DB ? drizzle(env.DB) : null, data),
  );
