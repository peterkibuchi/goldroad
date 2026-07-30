/**
 * The writer-facing read of GET /api/stats, shared by every surface that
 * shows a number a writer earned.
 *
 * Client-side, once, after mount — no loader wiring, no polling. The endpoint
 * is session-authed and same-origin, so a bare fetch carries the cookie for
 * free. Running only after hydration (never during SSR) means the first
 * render is always `loading` on both sides — server and client agree — and a
 * slow or flaky analytics provider upstream can never hold up the page's own
 * load.
 *
 * The four states are deliberately distinct, because they license completely
 * different UI:
 *  - `loading`  — we don't know yet. Render a skeleton, never a zero.
 *  - `off`      — the provider isn't configured for this deployment. The
 *                 feature does not exist here: render NOTHING, not a teaser
 *                 and not an empty box.
 *  - `unavailable` — configured, but this request couldn't be served. Say so
 *                 in one quiet line; never substitute a number.
 *  - `ready`    — real counts.
 */
import { useEffect, useState } from "react";

import type { StatsResponse } from "~/lib/stats";

export type StatsState =
  | { status: "loading" }
  | { status: "off" }
  | { status: "unavailable" }
  | {
      status: "ready";
      total: number;
      paths: Array<{ path: string; views: number }>;
    };

export function useWriterStats(): StatsState {
  const [state, setState] = useState<StatsState>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    fetch("/api/stats")
      .then((res) =>
        res.ok
          ? (res.json() as Promise<StatsResponse>)
          : Promise.reject(new Error(String(res.status))),
      )
      .then((data) => {
        if (cancelled) return;
        if (!data.enabled) {
          setState({ status: "off" });
        } else if ("error" in data) {
          setState({ status: "unavailable" });
        } else {
          setState({ status: "ready", total: data.total, paths: data.paths });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ status: "unavailable" });
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}
