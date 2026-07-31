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
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("purgeExpiredOauthKv — the purge query (audit #7)", () => {
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

describe("selfCheck — core invariants (audit #6)", () => {
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

describe("runScheduled — five jobs, one hourly trigger, none able to sink another", () => {
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
    });

    await runScheduled(envWithHook());

    expect(snapshots.runFollowerSnapshotPass).toHaveBeenCalledTimes(1);
    expect(backup.runBackupCheck).toHaveBeenCalledTimes(1);
  });

  it("does not page the owner about a writer's own failed post", async () => {
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
    });

    await runScheduled(envWithHook());

    // The writer is the person who can fix a revoked grant, and the posts
    // manager tells them. The webhook is for invariants nobody else watches.
    expect(posts).toHaveLength(0);
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
});

describe("reportFailures — alert only when a webhook AND failures exist", () => {
  it("POSTs when both are present", async () => {
    const spy = vi.fn(async () => new Response(null));
    vi.stubGlobal("fetch", spy);
    expect(await reportFailures("https://hook.example", ["down"])).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("no-ops without a webhook (WEBHOOK_URL absent)", async () => {
    const spy = vi.fn(async () => new Response(null));
    vi.stubGlobal("fetch", spy);
    expect(await reportFailures(undefined, ["down"])).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("no-ops when there are no failures", async () => {
    const spy = vi.fn(async () => new Response(null));
    vi.stubGlobal("fetch", spy);
    expect(await reportFailures("https://hook.example", [])).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});
