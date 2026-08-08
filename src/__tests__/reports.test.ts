// @vitest-environment node
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildReportAlert,
  MAX_ALERT_REASON_CHARS,
  MAX_REPORTS_PER_ALERT,
  markReportsNotified,
  type PendingReport,
  type ReportAlert,
  type ReportStore,
  runReportAlertPass,
  selectUnnotifiedReports,
} from "../lib/reports";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const NOW = 1_785_400_000_000;
const HOUR = 3_600_000;
const HOOK = "https://hook.example";
const EMAIL = "reporter@example.com";

/** A stored report, including the column the alert path must never send. */
type Row = {
  id: number;
  url: string;
  reason: string;
  email: string | null;
  notifiedAt: Date | null;
};

function row(id: number, overrides: Partial<Row> = {}): Row {
  return {
    id,
    url: `https://trygoldroad.com/post/${id}`,
    reason: `report ${id}`,
    email: EMAIL,
    notifiedAt: null,
    ...overrides,
  };
}

/**
 * An in-memory `reports` table. It projects `email` away exactly as
 * `selectUnnotifiedReports` does, so the pass is handed the shape D1 would hand
 * it — while the rows themselves still carry an address, which is what lets a
 * test prove the address never reaches the wire.
 */
function memoryStore(rows: Row[]) {
  const store: ReportStore = {
    async unnotified(limit) {
      return rows
        .filter((r) => r.notifiedAt === null)
        .slice(0, limit)
        .map(({ id, url, reason }) => ({ id, url, reason }));
    },
    async markNotified(ids, at) {
      for (const r of rows) {
        if (ids.includes(r.id)) r.notifiedAt = at;
      }
    },
  };
  return { rows, store };
}

/** ids still waiting to be alerted. */
function unnotifiedIds(rows: Row[]): number[] {
  return rows.filter((r) => r.notifiedAt === null).map((r) => r.id);
}

type SpyCall = { url: string; init: RequestInit };

/** A webhook answering `status`, recording everything it was posted. */
function webhookSpy(status = 200) {
  const calls: SpyCall[] = [];
  const fetcher = async (url: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(null, { status });
  };
  return { calls, fetcher: fetcher as unknown as typeof fetch };
}

/** The alert body of the nth POST. */
function sentAlert(calls: SpyCall[], index = 0): ReportAlert {
  return JSON.parse(String(calls[index].init.body)) as ReportAlert;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Build-only drizzle instance; .toSQL() never touches the (empty) client.
// biome-ignore lint/suspicious/noExplicitAny: no live D1 needed to build SQL
const db = drizzle({} as any);

describe("the watermark queries", () => {
  it("reads only reports nobody has been told about, oldest first", () => {
    const { sql, params } = selectUnnotifiedReports(db, 50).toSQL();
    const lower = sql.toLowerCase();
    expect(lower).toContain('from "reports"');
    expect(lower).toContain("notified_at");
    expect(lower).toContain("is null");
    expect(lower).toContain("order by");
    expect(lower).toContain("created_at");
    expect(params).toContain(50);
  });

  it("never selects the reporter's email", () => {
    // The projection IS the PII boundary: a column this query does not read
    // cannot be leaked by a later change to the payload builder.
    const { sql } = selectUnnotifiedReports(db).toSQL();
    expect(sql).not.toContain("email");
  });

  it("caps the read at the alert batch size by default", () => {
    const { params } = selectUnnotifiedReports(db).toSQL();
    expect(params).toContain(MAX_REPORTS_PER_ALERT);
  });

  it("stamps exactly the ids it is given, not a time range", () => {
    // A range would also stamp rows that arrived while the POST was in flight.
    const at = new Date(NOW);
    const { sql, params } = markReportsNotified(db, [4, 7], at).toSQL();
    const lower = sql.toLowerCase();
    expect(lower).toContain('update "reports"');
    expect(lower).toContain("notified_at");
    expect(lower).toContain(" in ");
    expect(params).toContain(4);
    expect(params).toContain(7);
  });
});

describe("the watermark, against a real SQLite built from the migrations", () => {
  /**
   * The schema file and the committed migrations can drift, and this whole
   * pass turns on a column that only exists if the migration was generated and
   * applied. Asserting on SQL strings would not notice: these run the real
   * statements against the real DDL, so a `notified_at` that never made it into
   * `drizzle/` fails here rather than at 3am against production.
   */
  function migrationStatements(table: string): string[] {
    const dir = new URL("../../drizzle/", import.meta.url);
    return readdirSync(dir)
      .filter((file) => file.endsWith(".sql"))
      .sort()
      .flatMap((file) =>
        readFileSync(new URL(file, dir), "utf8").split(
          "--> statement-breakpoint",
        ),
      )
      .map((statement) => statement.trim())
      .filter((statement) => statement.includes(table));
  }

  /** Two reports, oldest first, one of them carrying a reporter's email. */
  function freshDb() {
    const sqlite = new DatabaseSync(":memory:");
    const statements = migrationStatements("reports");
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) sqlite.exec(statement);
    sqlite.exec(`insert into reports (id, url, reason, email, created_at)
      values (1, 'https://a', 'oldest', 'a@example.com', 100),
             (2, 'https://b', 'newer', null, 200)`);
    return sqlite;
  }

  type Builder = { toSQL(): { sql: string; params: unknown[] } };
  function run(sqlite: DatabaseSync, builder: Builder) {
    const { sql, params } = builder.toSQL();
    // biome-ignore lint/suspicious/noExplicitAny: sqlite params are primitives
    return sqlite.prepare(sql).run(...(params as any[]));
  }
  function all(sqlite: DatabaseSync, builder: Builder) {
    const { sql, params } = builder.toSQL();
    // biome-ignore lint/suspicious/noExplicitAny: sqlite params are primitives
    return sqlite.prepare(sql).all(...(params as any[]));
  }

  it("gives `reports` a notified_at column", () => {
    const info = freshDb().prepare("pragma table_info(reports)").all();
    const names = info.map((column) => (column as { name: string }).name);
    expect(names).toContain("notified_at");
  });

  it("reads every report and no email at all before anything is stamped", () => {
    const sqlite = freshDb();
    expect(all(sqlite, selectUnnotifiedReports(db, 10))).toEqual([
      { id: 1, url: "https://a", reason: "oldest" },
      { id: 2, url: "https://b", reason: "newer" },
    ]);
  });

  it("drops a stamped report from the next read and leaves the rest", () => {
    // The watermark in one line: what went out stops coming back, what didn't
    // keeps coming back until it does.
    const sqlite = freshDb();
    run(sqlite, markReportsNotified(db, [1], new Date(NOW)));
    expect(all(sqlite, selectUnnotifiedReports(db, 10))).toEqual([
      { id: 2, url: "https://b", reason: "newer" },
    ]);
  });
});

describe("buildReportAlert — what a chat channel is allowed to see", () => {
  it("carries the count, the reported URLs and the reasons", () => {
    const alert = buildReportAlert([
      { id: 1, url: "https://trygoldroad.com/a", reason: "impersonation" },
      { id: 2, url: "https://trygoldroad.com/b", reason: "spam" },
    ]);
    expect(alert.count).toBe(2);
    expect(alert.reports.map((r) => r.url)).toEqual([
      "https://trygoldroad.com/a",
      "https://trygoldroad.com/b",
    ]);
    expect(alert.reports.map((r) => r.reason)).toEqual([
      "impersonation",
      "spam",
    ]);
  });

  it("says where to triage instead of shipping the queue", () => {
    const alert = buildReportAlert([{ id: 1, url: "u", reason: "r" }]);
    expect(alert.triage).toContain("reports");
  });

  it("drops an email spliced onto a row rather than spreading it through", () => {
    // The builder projects field by field. If it ever grew a `...row`, this is
    // the test that fails: an address left for follow-up is not for broadcast.
    const leaky = { id: 1, url: "u", reason: "r", email: EMAIL };
    const alert = buildReportAlert([leaky as PendingReport]);
    expect(JSON.stringify(alert)).not.toContain(EMAIL);
  });

  it("clips a long reason so one report cannot cost the whole alert", () => {
    // 50 unclipped 2,000-character notes is a body most chat webhooks reject —
    // saying more about one report would lose the alert about all of them.
    const reason = "x".repeat(MAX_ALERT_REASON_CHARS + 500);
    const [only] = buildReportAlert([{ id: 1, url: "u", reason }]).reports;
    expect(only.reason.length).toBeLessThanOrEqual(MAX_ALERT_REASON_CHARS + 1);
  });

  it("leaves a short reason exactly as written", () => {
    const reason = "this page is impersonating me";
    const [only] = buildReportAlert([{ id: 1, url: "u", reason }]).reports;
    expect(only.reason).toBe(reason);
  });
});

describe("runReportAlertPass — the stamp follows the POST, never precedes it", () => {
  it("never POSTs when there is nothing new to say", async () => {
    const { rows, store } = memoryStore([
      row(1, { notifiedAt: new Date(NOW) }),
    ]);
    const { calls, fetcher } = webhookSpy();

    const result = await runReportAlertPass({
      store,
      webhook: HOOK,
      fetcher,
      now: NOW,
    });

    expect(result).toEqual({
      found: 0,
      sent: false,
      notified: 0,
      capped: false,
    });
    expect(calls).toHaveLength(0);
    expect(unnotifiedIds(rows)).toEqual([]);
  });

  it("stamps nothing when no WEBHOOK_URL is set", async () => {
    // Silence is not delivery. The reports stay in D1 and go out whole on the
    // first tick after a webhook is configured; stamping would discard them.
    const { rows, store } = memoryStore([row(1), row(2)]);
    const { calls, fetcher } = webhookSpy();

    const result = await runReportAlertPass({ store, fetcher, now: NOW });

    expect(result.found).toBe(2);
    expect(result.sent).toBe(false);
    expect(result.notified).toBe(0);
    expect(calls).toHaveLength(0);
    expect(unnotifiedIds(rows)).toEqual([1, 2]);
  });

  it("stamps exactly what it sent, and a second pass sends nothing", async () => {
    const { rows, store } = memoryStore([row(1), row(2), row(3)]);
    const { calls, fetcher } = webhookSpy();

    const first = await runReportAlertPass({
      store,
      webhook: HOOK,
      fetcher,
      now: NOW,
    });

    expect(first).toEqual({
      found: 3,
      sent: true,
      notified: 3,
      capped: false,
    });
    expect(sentAlert(calls).reports.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(unnotifiedIds(rows)).toEqual([]);
    expect(rows.every((r) => r.notifiedAt?.getTime() === NOW)).toBe(true);

    const second = await runReportAlertPass({
      store,
      webhook: HOOK,
      fetcher,
      now: NOW + HOUR,
    });

    expect(second.found).toBe(0);
    expect(second.sent).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("leaves the rows unnotified when the webhook answers non-2xx", async () => {
    // `res.ok`, not merely "didn't throw": a 500 from the chat provider is a
    // message nobody received, and a stamp on it loses the report for good.
    const { rows, store } = memoryStore([row(1), row(2)]);
    const { fetcher } = webhookSpy(500);

    const result = await runReportAlertPass({
      store,
      webhook: HOOK,
      fetcher,
      now: NOW,
    });

    expect(result.sent).toBe(false);
    expect(result.notified).toBe(0);
    expect(unnotifiedIds(rows)).toEqual([1, 2]);
  });

  it("retries the same reports on the next pass after a failed POST", async () => {
    const { rows, store } = memoryStore([row(1), row(2)]);
    async function refused(): Promise<Response> {
      throw new Error("socket hang up");
    }

    const first = await runReportAlertPass({
      store,
      webhook: HOOK,
      fetcher: refused as unknown as typeof fetch,
      now: NOW,
    });

    expect(first.sent).toBe(false);
    expect(unnotifiedIds(rows)).toEqual([1, 2]);

    const { calls, fetcher } = webhookSpy();
    const second = await runReportAlertPass({
      store,
      webhook: HOOK,
      fetcher,
      now: NOW + HOUR,
    });

    expect(second).toEqual({
      found: 2,
      sent: true,
      notified: 2,
      capped: false,
    });
    expect(sentAlert(calls).reports.map((r) => r.id)).toEqual([1, 2]);
    expect(unnotifiedIds(rows)).toEqual([]);
  });

  it("re-alerts rather than loses a report when the stamp fails", async () => {
    // A duplicate ping about a report already triaged is cheap. The opposite
    // mistake is a takedown nobody hears about.
    const { store } = memoryStore([row(1)]);
    const broken: ReportStore = {
      unnotified: store.unnotified,
      markNotified: async () => {
        throw new Error("locked");
      },
    };
    const { calls, fetcher } = webhookSpy();

    const result = await runReportAlertPass({
      store: broken,
      webhook: HOOK,
      fetcher,
      now: NOW,
    });

    expect(result.sent).toBe(true);
    expect(result.notified).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("never POSTs when the read itself fails", async () => {
    // "Cannot read reports" must not look like "no reports" — the likeliest
    // cause is the migration never having been applied.
    const { calls, fetcher } = webhookSpy();

    const result = await runReportAlertPass({
      store: {
        unnotified: async () => {
          throw new Error("no such column: notified_at");
        },
        markNotified: async () => undefined,
      },
      webhook: HOOK,
      fetcher,
      now: NOW,
    });

    expect(result).toEqual({
      found: 0,
      sent: false,
      notified: 0,
      capped: false,
    });
    expect(calls).toHaveLength(0);
  });

  it("respects the batch cap and rolls the rest to the next pass", async () => {
    // One flood must not build an unbounded payload. The overflow is not lost:
    // it stays unnotified, the same retry path a failed POST uses.
    const { rows, store } = memoryStore(
      Array.from({ length: 7 }, (_, i) => row(i + 1)),
    );
    const { calls, fetcher } = webhookSpy();

    const first = await runReportAlertPass({
      store,
      webhook: HOOK,
      fetcher,
      now: NOW,
      cap: 3,
    });

    expect(first).toEqual({ found: 3, sent: true, notified: 3, capped: true });
    const alert = sentAlert(calls);
    expect(alert.count).toBe(3);
    expect(alert.reports.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(unnotifiedIds(rows)).toEqual([4, 5, 6, 7]);

    const second = await runReportAlertPass({
      store,
      webhook: HOOK,
      fetcher,
      now: NOW + HOUR,
      cap: 3,
    });

    expect(second.notified).toBe(3);
    expect(unnotifiedIds(rows)).toEqual([7]);
  });

  it("never puts the reporter's email on the wire", async () => {
    const { store } = memoryStore([row(1), row(2, { email: null })]);
    const { calls, fetcher } = webhookSpy();

    await runReportAlertPass({ store, webhook: HOOK, fetcher, now: NOW });

    const body = String(calls[0].init.body);
    expect(body).not.toContain(EMAIL);
    expect(body).not.toContain("email");
    // ...while still carrying what a triager needs in order to act.
    expect(body).toContain("https://trygoldroad.com/post/1");
    expect(body).toContain("report 1");
  });

  it("POSTs JSON to the configured webhook", async () => {
    const { store } = memoryStore([row(1)]);
    const { calls, fetcher } = webhookSpy();

    await runReportAlertPass({
      store,
      webhook: "https://hook.example/services/xyz",
      fetcher,
      now: NOW,
    });

    expect(calls[0].url).toBe("https://hook.example/services/xyz");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toMatchObject({
      "content-type": "application/json",
    });
  });
});
