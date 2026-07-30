/**
 * Builders for the `/api/stats` payload, shared by every surface test that
 * shows a number a writer earned.
 *
 * The endpoint answers with a SECTIONED envelope, and the writer-stats hook
 * reads only its `views` section. Tests must speak that shape: a stub that
 * invents a flatter payload keeps passing while the real surface renders
 * nothing, which is precisely the failure these builders exist to prevent.
 */

type ViewsInput = {
  status: string;
  total?: number;
  paths?: Array<{ path: string; views: number }>;
};

export function viewsEnvelope(views: ViewsInput) {
  return {
    range: "30d",
    generatedAt: "2026-07-30T00:00:00.000Z",
    views,
    sources: { status: "not_configured" },
    followers: { status: "not_configured" },
    engagement: { status: "not_configured" },
  };
}

/** The provider isn't configured here: surfaces must render no numbers at all. */
export const VIEWS_OFF = viewsEnvelope({ status: "not_configured" });

/** Configured, but this read couldn't be served — never substitute a zero. */
export const VIEWS_UNAVAILABLE = viewsEnvelope({ status: "unavailable" });

/** A healthy read. */
export function viewsReady(
  total: number,
  paths: Array<{ path: string; views: number }> = [],
) {
  return viewsEnvelope({ status: "ok", total, paths });
}
