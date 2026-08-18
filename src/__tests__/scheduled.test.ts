// @vitest-environment node
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const snapshots = vi.hoisted(() => ({
  d1SnapshotStore: vi.fn(() => ({ store: true })),
  runFollowerSnapshotPass: vi.fn(async () => ({
    day: "2026-07-29",
    attempted: 0,
    sampled: 0,
    failed: 0,
    pruned: true,
  })),
}));
vi.mock("~/lib/follower-snapshots", () => snapshots);

const scheduledPosts = vi.hoisted(() => ({
  d1ScheduledPostStore: vi.fn(() => ({ scheduleStore: true })),
  runScheduledPublishPass: vi.fn(async () => ({
    attempted: 0,
    published: 0,
    failed: 0,
    retrying: 0,
    contended: 0,
    releasedStale: 0,
    capped: false,
    pruned: true,
    announceFailures: [] as string[],
  })),
}));
vi.mock("~/lib/scheduled-posts", () => scheduledPosts);

const scheduledPublish = vi.hoisted(() => ({
  cronPublisher: vi.fn(() => ({ publisher: true })),
}));
vi.mock("~/lib/scheduled-publish", () => scheduledPublish);

const backup = vi.hoisted(() => ({
  d1BackupStore: vi.fn(() => ({ backupStore: true })),
  runBackupCheck: vi.fn(async () => ({
    failures: [] as string[],
    pruned: true,
  })),
}));
vi.mock("~/lib/backup", () => backup);

const reports = vi.hoisted(() => ({
  d1ReportStore: vi.fn(() => ({ reportStore: true })),
  runReportAlertPass: vi.fn(async () => ({
    found: 0,
    sent: false,
    notified: 0,
    capped: false,
    failures: [] as string[],
  })),
}));
vi.mock("~/lib/reports", () => reports);

import {
  ALERT_TIMEOUT_MS,
  MAX_ALERT_SUMMARY_CHARS,
} from "../lib/alert-webhook";
import {
  purgeExpiredOauthKv,
  reportFailures,
  runScheduled,
  selfCheck,
} from "../lib/scheduled";

// Both module mocks get their default behaviour re-established per test, so no
// test inherits another's call counts or a restored-away implementation.
beforeEach(() => {
  vi.clearAllMocks();
  snapshots.d1SnapshotStore.mockReturnValue({ store: true });
  snapshots.runFollowerSnapshotPass.mockResolvedValue({
    day: "2026-07-29",
    attempted: 0,
    sampled: 0,
    failed: 0,
    pruned: true,
  });
  backup.d1BackupStore.mockReturnValue({ backupStore: true });
  backup.runBackupCheck.mockResolvedValue({ failures: [], pruned: true });
  reports.d1ReportStore.mockReturnValue({ reportStore: true });
  reports.runReportAlertPass.mockResolvedValue({
    found: 0,
    sent: false,
    notified: 0,
    capped: false,
    failures: [],
  });
  scheduledPosts.d1ScheduledPostStore.mockReturnValue({ scheduleStore: true });
  scheduledPublish.cronPublisher.mockReturnValue({ publisher: true });
  scheduledPosts.runScheduledPublishPass.mockResolvedValue({
    attempted: 0,
    published: 0,
    failed: 0,
    retrying: 0,
    contended: 0,
    releasedStale: 0,
    capped: false,
    pruned: true,
    announceFailures: [],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("purgeExpiredOauthKv — the purge query", () => {
  it("deletes oauth_kv rows with a set, past expiry — and never null ones", () => {
    // Build-only drizzle instance; .toSQL() never touches the (empty) client.
    // biome-ignore lint/suspicious/noExplicitAny: no live D1 needed to build SQL
    const db = drizzle({} as any);
    const now = 1_727_000_000_000;
    const { sql, params } = purgeExpiredOauthKv(db, now).toSQL();
    expect(sql.toLowerCase()).toContain('delete from "oauth_kv"');
    expect(sql).toContain("expires_at");
    // The condition is: expires_at IS NOT NULL AND expires_at <= <now>.
    expect(sql.toLowerCase()).toContain("is not null");
    expect(params).toContain(now);
  });
});

describe("selfCheck — core invariants", () => {
  const origin = "https://trygoldroad.com";

  function stubFetch(
    root: () => Response,
    metadata: () => Response = () =>
      Response.json({
        client_id: "https://trygoldroad.com/oauth/client-metadata.json",
      }),
  ) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo) => {
        const url = String(input);
        if (url.includes("client-metadata")) return metadata();
        return root();
      }),
    );
  }

  it("returns no failures when the site is healthy", async () => {
    stubFetch(() => new Response("<html>Goldroad</html>", { status: 200 }));
    expect(await selfCheck(origin)).toEqual([]);
  });

  it("flags a non-200 landing page", async () => {
    stubFetch(() => new Response("", { status: 503 }));
    const failures = await selfCheck(origin);
    expect(failures.some((f) => f.includes("GET / -> 503"))).toBe(true);
  });

  it("flags a wrong OAuth client_id", async () => {
    stubFetch(
      () => new Response("<html>Goldroad</html>", { status: 200 }),
      () => Response.json({ client_id: "https://evil.example/x" }),
    );
    const failures = await selfCheck(origin);
    expect(failures.some((f) => f.includes("client_id"))).toBe(true);
  });
});

describe("runScheduled — six jobs, one hourly trigger, none able to sink another", () => {
  function healthyOrigin() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo) =>
        String(input).includes("client-metadata")
          ? Response.json({
              client_id: "https://trygoldroad.com/oauth/client-metadata.json",
            })
          : new Response("<html>Goldroad</html>"),
      ),
    );
  }

  /** A binding that fails every statement — the purge below rejects on it. */
  function brokenDb() {
    return { DB: {} } as unknown as Env;
  }

  function quiet() {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  }

  /** An Env carrying the optional alert webhook. */
  function envWithHook() {
    const env = { DB: {}, WEBHOOK_URL: "https://hook.example" };
    return env as unknown as Env & { WEBHOOK_URL: string };
  }

  it("publishes due posts FIRST — the one job whose lateness a reader sees", async () => {
    // Everything after this is self-healing next hour or already reported by
    // CI; a tick that runs out of budget before reaching this one is a
    // writer's post going out late, which nothing else here can undo.
    healthyOrigin();
    quiet();
    const order: string[] = [];
    scheduledPosts.runScheduledPublishPass.mockImplementation(async () => {
      order.push("scheduled");
      return {
        attempted: 1,
        published: 1,
        failed: 0,
        retrying: 0,
        contended: 0,
        releasedStale: 0,
        capped: false,
        pruned: true,
        announceFailures: [],
      };
    });
    snapshots.runFollowerSnapshotPass.mockImplementation(async () => {
      order.push("snapshots");
      return {
        day: "2026-07-29",
        attempted: 0,
        sampled: 0,
        failed: 0,
        pruned: true,
      };
    });

    await runScheduled(brokenDb());

    expect(order).toEqual(["scheduled", "snapshots"]);
    expect(scheduledPosts.runScheduledPublishPass).toHaveBeenCalledWith({
      store: { scheduleStore: true },
      publish: { publisher: true },
    });
  });

  it("still runs every other job when the publish pass reports failures", async () => {
    // A writer's revoked grant is recorded on their row and shown to them in
    // the posts manager; it is not an operator's page, and it must not cost
    // anybody else their hour.
    healthyOrigin();
    quiet();
    scheduledPosts.runScheduledPublishPass.mockResolvedValue({
      attempted: 2,
      published: 0,
      failed: 2,
      retrying: 0,
      contended: 0,
      releasedStale: 0,
      capped: true,
      pruned: true,
      announceFailures: [],
    });

    await runScheduled(envWithHook());

    expect(snapshots.runFollowerSnapshotPass).toHaveBeenCalledTimes(1);
    expect(backup.runBackupCheck).toHaveBeenCalledTimes(1);
  });

  it("does not alert the operator about a writer's own failed post", async () => {
    const posts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("hook.example")) {
          posts.push(String(init?.body));
          return new Response(null);
        }
        return url.includes("client-metadata")
          ? Response.json({
              client_id: "https://trygoldroad.com/oauth/client-metadata.json",
            })
          : new Response("<html>Goldroad</html>");
      }),
    );
    quiet();
    scheduledPosts.runScheduledPublishPass.mockResolvedValue({
      attempted: 1,
      published: 0,
      failed: 1,
      retrying: 0,
      contended: 0,
      releasedStale: 0,
      capped: false,
      pruned: true,
      announceFailures: [],
    });

    await runScheduled(envWithHook());

    // The writer is the person who can fix a revoked grant, and the posts
    // manager tells them. The webhook is for invariants nobody else watches.
    expect(posts).toHaveLength(0);
  });

  /**
   * The counterpart of the test above, and the reason the two sit together: a
   * scheduled post that FAILED belongs to the writer, and one that PUBLISHED but
   * could not be announced belongs to the operator.
   *
   * The difference is not severity, it is who can act. A revoked grant is fixed
   * by the writer signing in again, and the posts manager shows them the reason.
   * An announce that was refused cannot be told to them at all: the row is about
   * to be marked published and `last_error` is what the manager renders as "this
   * didn't go out", so writing it there would report a live post as broken. That
   * leaves a console line at 09:00, which reaches nobody — hence this channel.
   */
  it("pages the operator when a scheduled post published but could not be announced", async () => {
    const posts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("hook.example")) {
          posts.push(String(init?.body));
          return new Response(null);
        }
        return url.includes("client-metadata")
          ? Response.json({
              client_id: "https://trygoldroad.com/oauth/client-metadata.json",
            })
          : new Response("<html>Goldroad</html>");
      }),
    );
    quiet();
    scheduledPosts.runScheduledPublishPass.mockResolvedValue({
      attempted: 1,
      published: 1,
      failed: 0,
      retrying: 0,
      contended: 0,
      releasedStale: 0,
      capped: false,
      pruned: true,
      announceFailures: [
        "scheduled post row-1 published but its announce was refused (InvalidRequest)",
      ],
    });

    await runScheduled(envWithHook());

    expect(posts).toHaveLength(1);
    const body = JSON.parse(posts[0]) as { failures: string[] };
    expect(body.failures).toContain(
      "scheduled post row-1 published but its announce was refused (InvalidRequest)",
    );
  });

  it("samples follower counts even when the oauth_kv purge blows up", async () => {
    healthyOrigin();
    quiet();

    await runScheduled(brokenDb());

    // The purge failing is logged, not fatal: a missed sampling hour can never
    // be recovered, so it must not depend on an unrelated job succeeding.
    expect(snapshots.runFollowerSnapshotPass).toHaveBeenCalledTimes(1);
    expect(snapshots.d1SnapshotStore).toHaveBeenCalledTimes(1);
    expect(snapshots.runFollowerSnapshotPass).toHaveBeenCalledWith({
      store: { store: true },
    });
  });

  it("sends a stale backup down the SAME alert path as a self-check failure", async () => {
    // The whole point of folding the backup check into this cron: a backup that
    // silently stopped has to reach a human, and this is the path that already
    // does that.
    const posts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("hook.example")) {
          posts.push(String(init?.body));
          return new Response(null);
        }
        return url.includes("client-metadata")
          ? Response.json({
              client_id: "https://trygoldroad.com/oauth/client-metadata.json",
            })
          : new Response("<html>Goldroad</html>");
      }),
    );
    quiet();
    backup.runBackupCheck.mockResolvedValue({
      failures: ["newest backup is 73h old (max 48h)"],
      pruned: true,
    });

    await runScheduled(envWithHook());

    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("73h old");
  });

  it("does not alert when the backup is healthy and the site is up", async () => {
    const spy = vi.fn(async (input: URL | RequestInfo) =>
      String(input).includes("client-metadata")
        ? Response.json({
            client_id: "https://trygoldroad.com/oauth/client-metadata.json",
          })
        : new Response("<html>Goldroad</html>"),
    );
    vi.stubGlobal("fetch", spy);
    quiet();

    await runScheduled(envWithHook());

    const urls = spy.mock.calls.map((call) => String(call[0]));
    expect(urls.some((u) => u.includes("hook.example"))).toBe(false);
  });

  it("hands the abuse-report pass its store and the alert webhook", async () => {
    healthyOrigin();
    quiet();

    await runScheduled(envWithHook());

    expect(reports.d1ReportStore).toHaveBeenCalledTimes(1);
    expect(reports.runReportAlertPass).toHaveBeenCalledWith({
      store: { reportStore: true },
      webhook: "https://hook.example",
    });
  });

  it("pages the operator when the abuse-report pass cannot do its job", async () => {
    // The failure this exists for is the migration not being applied: the read
    // throws, and the pass's own result is then indistinguishable from a
    // healthy quiet hour. Abuse alerting would be dead with silence as its only
    // symptom — so its failures have to ride the channel that already exists.
    const posts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("hook.example")) {
          posts.push(String(init?.body));
          return new Response(null, { status: 204 });
        }
        return url.includes("client-metadata")
          ? Response.json({
              client_id: "https://trygoldroad.com/oauth/client-metadata.json",
            })
          : new Response("<html>Goldroad</html>");
      }),
    );
    quiet();
    reports.runReportAlertPass.mockResolvedValue({
      found: 0,
      sent: false,
      notified: 0,
      capped: false,
      failures: ["abuse reports could not be read for alerting"],
    });

    await runScheduled(envWithHook());

    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("could not be read");
    // On the same payload the self-check uses, so one receiver sees both.
    expect(JSON.parse(posts[0]).kind).toBe("self-check");
  });

  it("still self-checks and alerts when the abuse-report pass throws", async () => {
    // That pass is written never to throw; this guards it anyway, because a
    // surprise inside it must not cost the jobs after it their hour.
    const posts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("hook.example")) {
          posts.push(String(init?.body));
          return new Response(null);
        }
        return url.includes("client-metadata")
          ? Response.json({
              client_id: "https://trygoldroad.com/oauth/client-metadata.json",
            })
          : new Response("<html>Goldroad</html>");
      }),
    );
    quiet();
    reports.runReportAlertPass.mockRejectedValue(new Error("D1 exploded"));
    backup.runBackupCheck.mockResolvedValue({
      failures: ["newest backup is 73h old (max 48h)"],
      pruned: true,
    });

    await runScheduled(envWithHook());

    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("73h old");
  });

  it("says out loud when the alert itself was rejected", async () => {
    // The tick has nowhere to escalate to — this is the last job in the pass,
    // and nothing survives to the next one — so the log line is the only record
    // that the alert CHANNEL is what is broken rather than the site.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo) => {
        const url = String(input);
        if (url.includes("hook.example"))
          return new Response("bad request", { status: 400 });
        return url.includes("client-metadata")
          ? Response.json({
              client_id: "https://trygoldroad.com/oauth/client-metadata.json",
            })
          : new Response("<html>Goldroad</html>");
      }),
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    backup.runBackupCheck.mockResolvedValue({
      failures: ["newest backup is 73h old (max 48h)"],
      pruned: true,
    });

    await runScheduled(envWithHook());

    const logged = errors.mock.calls.map((call) => JSON.stringify(call));
    expect(logged.some((line) => line.includes("alert delivery"))).toBe(true);
  });
});

describe("reportFailures — alert only when a webhook AND failures exist", () => {
  /** The body of the nth POST, parsed. */
  function sent(spy: ReturnType<typeof vi.fn>, index = 0) {
    return JSON.parse(String(spy.mock.calls[index][1].body));
  }

  it("POSTs when both are present", async () => {
    const spy = vi.fn(async () => new Response(null));
    vi.stubGlobal("fetch", spy);
    expect(await reportFailures("https://hook.example", ["down"])).toEqual({
      attempted: true,
      failures: [],
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("no-ops without a webhook (WEBHOOK_URL absent)", async () => {
    const spy = vi.fn(async () => new Response(null));
    vi.stubGlobal("fetch", spy);
    expect(await reportFailures(undefined, ["down"])).toEqual({
      attempted: false,
      failures: [],
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("no-ops when there are no failures", async () => {
    const spy = vi.fn(async () => new Response(null));
    vi.stubGlobal("fetch", spy);
    expect(await reportFailures("https://hook.example", [])).toEqual({
      attempted: false,
      failures: [],
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("carries the summary line a chat webhook needs to accept the POST", async () => {
    // Discord answers 400 to a body with no `content`, Slack renders an empty
    // message without `text`. A payload of only our own fields is an alert that
    // is never delivered — and the structured fields are not rendered in a chat
    // channel at all, so the line has to say the useful thing by itself.
    const spy = vi.fn(async () => new Response(null));
    vi.stubGlobal("fetch", spy);

    await reportFailures("https://hook.example", ["GET / -> 503", "down"]);

    const body = sent(spy);
    expect(body.content).toContain("2 failures");
    expect(body.content).toContain("GET / -> 503");
    expect(body.text).toBe(body.content);
    // ...without losing what a JSON sink reads.
    expect(body.kind).toBe("self-check");
    expect(body.failures).toEqual(["GET / -> 503", "down"]);
  });

  it("clips the summary so one runaway failure string cannot become the alert", async () => {
    // A failure can embed a `String(err)` or a value read off a remote
    // response, so the headline is clipped rather than trusted to be short.
    const spy = vi.fn(async () => new Response(null));
    vi.stubGlobal("fetch", spy);

    await reportFailures("https://hook.example", [`x`.repeat(5_000)]);

    const body = sent(spy);
    expect(body.content.length).toBeLessThanOrEqual(
      MAX_ALERT_SUMMARY_CHARS + 1,
    );
    // The full text still travels in the structured field.
    expect(body.failures[0]).toHaveLength(5_000);
  });

  it("calls a non-2xx a failed delivery rather than a delivery", async () => {
    // This is the failure the old `.catch()` could not see: a rejected POST
    // RESOLVES, so a webhook answering 400 to every alert looked exactly like a
    // webhook accepting them.
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad request", { status: 400 })),
    );

    const result = await reportFailures("https://hook.example", ["down"]);

    expect(result.attempted).toBe(true);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("400");
  });

  it("bounds the POST so a webhook that never answers cannot hold the tick open", async () => {
    // A webhook that accepts the connection and then says nothing is worse than
    // one that refuses: this is the last job in an hourly cron, so an unbounded
    // POST parks the whole tick on a third party we don't run. The abuse alert
    // has always carried this deadline; this one did not.
    let seen: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        seen = init;
        return new Response(null);
      }),
    );

    await reportFailures("https://hook.example", ["down"]);

    expect(seen?.signal).toBeInstanceOf(AbortSignal);
    expect(seen?.signal?.aborted).toBe(false);
  });

  it("counts a timed-out alert as a failed delivery, and says which it was", async () => {
    // The rejection `AbortSignal.timeout` actually produces. A hanging webhook
    // and a wrong URL need different fixes, so the line says which happened.
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      }),
    );

    const result = await reportFailures("https://hook.example", ["down"]);

    expect(result.attempted).toBe(true);
    expect(result.failures).toEqual([
      `self-check alert timed out after ${ALERT_TIMEOUT_MS} ms`,
    ]);
  });

  it("reports a network rejection rather than swallowing it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED");
      }),
    );

    const result = await reportFailures("https://hook.example", ["down"]);

    expect(result.attempted).toBe(true);
    expect(result.failures).toEqual([
      "self-check alert could not be delivered",
    ]);
  });
});
