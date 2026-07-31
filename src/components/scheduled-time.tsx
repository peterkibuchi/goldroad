import { useEffect, useState } from "react";

import {
  formatLocalScheduledAt,
  formatUtcScheduledAt,
} from "~/lib/schedule-time";

/**
 * A scheduled moment, in the writer's own zone — the one date in this app that
 * cannot be rendered in UTC and left at that.
 *
 * Every other date here is formatted with a fixed locale AND `timeZone: "UTC"`
 * (see formatDate in ~/components/document-article) precisely so the server and
 * the browser produce identical strings and hydration never drifts. That trick
 * doesn't work for a schedule: "publishes Tuesday at 09:00" only means anything
 * in the zone the writer chose it in, and the server has no idea what that is.
 *
 * So the first paint labels the instant in UTC, with "UTC" on it — a less useful
 * time, never a wrong one — and an effect swaps in the local reading once the
 * browser can tell us. Both readings name their zone, so no glance at this
 * element can be misread, mid-swap or otherwise. `dateTime` carries the machine
 * -readable instant throughout.
 */
export function ScheduledTime({ iso }: { iso: string }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <time dateTime={iso}>
      {mounted ? formatLocalScheduledAt(iso) : formatUtcScheduledAt(iso)}
    </time>
  );
}
