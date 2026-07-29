/**
 * Same-writer "More from <publication>" selection (owner decision #3,
 * substack-patterns dossier: same-writer only — no cross-writer discovery
 * surface exists yet, and ranking one writer's work over another's is a
 * values question the platform hasn't answered). Pure record → view-model
 * transform, mirrors ~/lib/dashboard's mapDashboardRows shape.
 */
import {
  type ListedRecord,
  rkeyFromUri,
  type StandardDocument,
} from "~/lib/atproto";

export type RelatedPost = {
  rkey: string;
  title: string;
  publishedAt: string | null;
};

export const RELATED_POSTS_LIMIT = 3;

/**
 * Picks the most recent OTHER posts from an already-fetched page of the
 * writer's own document records — no new privacy surface, no ranking
 * decision beyond recency. Untitled or unkeyed records are dropped
 * (matching mapDashboardRows' own list-hygiene rule), and the current
 * document is always excluded.
 */
export function selectRelatedPosts(
  records: ListedRecord<StandardDocument>[],
  excludeRkey: string,
  limit = RELATED_POSTS_LIMIT,
): RelatedPost[] {
  return records
    .flatMap((r) => {
      const rkey = rkeyFromUri(r.uri);
      if (!rkey || rkey === excludeRkey) return [];
      if (typeof r.value.title !== "string" || r.value.title.trim() === "")
        return [];
      return [
        {
          rkey,
          title: r.value.title,
          publishedAt:
            typeof r.value.publishedAt === "string"
              ? r.value.publishedAt
              : null,
        },
      ];
    })
    .sort(
      (a, b) =>
        Date.parse(b.publishedAt ?? "") - Date.parse(a.publishedAt ?? "") ||
        (a.rkey < b.rkey ? 1 : -1),
    )
    .slice(0, limit);
}
