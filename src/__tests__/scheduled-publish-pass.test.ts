// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_PUBLISH_ATTEMPTS,
  MAX_PUBLISHES_PER_TICK,
  type PublishAttempt,
  runScheduledPublishPass,
  type ScheduledPostStore,
  STALE_CLAIM_MS,
} from "../lib/scheduled-posts";

/**
 * The per-tick pass, exercised against a fake store — no D1, no PDS, no OAuth.
 *
 * Everything this suite pins is about a cron firing hours after the writer left:
 *
 *  - a row is CLAIMED before any work happens, and losing the claim is not an
 *    error (cron-vs-cron, working as designed);
 *  - the per-tick cap is REPORTED, never silent — a cap that reads as "handled
 *    everything" is the same lie as a silent failure;
 *  - retries end. A transient failure comes back next tick, and after
 *    MAX_PUBLISH_ATTEMPTS the post FAILS with a reason instead of staying
 *    "pending" for a week;
 *  - a publisher that throws is a bug in the publisher, not a verdict on the
 *    post, so the row survives to try again;
 *  - a lease nobody is holding is handed back rather than stranding the post.
 */

const NOW = Date.parse("2026-08-04T09:00:00.000Z");

type Row = {
  id: string;
  did: string;
  draftId: string;
  attempts: number;
  claimed: boolean;
  /** The announce decision the row captured at scheduling time. The pass never
   * looks at it — it belongs to the publisher — but it is part of a due row. */
  announce?: boolean;
};

/** A store over plain objects, recording the terminal writes. */
function fakeStore(rows: Row[]) {
  const calls = {
    published: [] as Array<{ id: string; rkey: string }>,
    failed: [] as Array<{ id: string; reason: string }>,
    retried: [] as Array<{ id: string; reason: string }>,
    releasedStale: 0,
    pruned: [] as Date[],
    dueLimits: [] as number[],
  };
  const store: ScheduledPostStore = {
    async due(_now, limit) {
      calls.dueLimits.push(limit);
      return rows
        .filter((row) => !row.claimed)
        .slice(0, limit)
        .map(({ id, did, draftId, announce }) => ({
          id,
          did,
          draftId,
          announce: announce ?? false,
        }));
    },
    async claim(id) {
      const row = rows.find((r) => r.id === id);
      if (!row || row.claimed) return null;
      row.claimed = true;
      row.attempts += 1;
      return row.attempts;
    },
    async published(id, rkey) {
      calls.published.push({ id, rkey });
      return undefined;
    },
    async failed(id, reason) {
      calls.failed.push({ id, reason });
      return undefined;
    },
    async retry(id, reason) {
      calls.retried.push({ id, reason });
      return undefined;
    },
    async releaseStale() {
      calls.releasedStale += 1;
      return [];
    },
    async prune(before) {
      calls.pruned.push(before);
      return undefined;
    },
  };
  return { store, calls };
}

function row(id: string, attempts = 0): Row {
  return {
    id,
    did: `did:plc:writer${id}`,
    draftId: `draft-${id}`,
    attempts,
    claimed: false,
  };
}

const published: PublishAttempt = { ok: true, rkey: "3lyk73wxnok2f" };

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the claim comes before the work", () => {
  it("publishes only rows it won the claim for", async () => {
    const { store, calls } = fakeStore([row("a")]);
    const publish = vi.fn(async () => published);
    const result = await runScheduledPublishPass({ store, publish, now: NOW });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(calls.published).toEqual([{ id: "a", rkey: "3lyk73wxnok2f" }]);
    expect(result.attempted).toBe(1);
    expect(result.published).toBe(1);
  });

  it("skips a row another tick already claimed, and does not call that a failure", async () => {
    const { store, calls } = fakeStore([row("a")]);
    // Simulates the other tick winning between the due read and the claim.
    const original = store.claim;
    store.claim = async () => {
      store.claim = original;
      return null;
    };
    const publish = vi.fn(async () => published);
    const result = await runScheduledPublishPass({ store, publish, now: NOW });
    expect(publish).not.toHaveBeenCalled();
    expect(result.contended).toBe(1);
    expect(result.attempted).toBe(0);
    expect(calls.failed).toHaveLength(0);
    expect(calls.retried).toHaveLength(0);
  });

  it("never publishes the same row twice within a tick", async () => {
    const { store } = fakeStore([row("a")]);
    const publish = vi.fn(async () => published);
    await runScheduledPublishPass({ store, publish, now: NOW });
    await runScheduledPublishPass({ store, publish, now: NOW });
    // The row is claimed after the first pass, so the second sees nothing.
    expect(publish).toHaveBeenCalledTimes(1);
  });
});

describe("the per-tick cap is bounded AND reported", () => {
  it("publishes at most `cap` posts, leaving the rest for the next tick", async () => {
    const { store } = fakeStore([
      row("a"),
      row("b"),
      row("c"),
      row("d"),
      row("e"),
      row("f"),
      row("g"),
    ]);
    const publish = vi.fn(async () => published);
    const result = await runScheduledPublishPass({
      store,
      publish,
      now: NOW,
      cap: 5,
    });
    expect(publish).toHaveBeenCalledTimes(5);
    expect(result.published).toBe(5);
  });

  it("says a queue was left behind — in the result AND in the log", async () => {
    const { store } = fakeStore([row("a"), row("b"), row("c")]);
    const result = await runScheduledPublishPass({
      store,
      publish: async () => published,
      now: NOW,
      cap: 2,
    });
    expect(result.capped).toBe(true);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("per-tick cap"),
    );
  });

  it("does not claim a cap when the queue exactly fits", async () => {
    const { store } = fakeStore([row("a"), row("b")]);
    const result = await runScheduledPublishPass({
      store,
      publish: async () => published,
      now: NOW,
      cap: 2,
    });
    expect(result.capped).toBe(false);
  });

  it("asks for one more than the cap, so 'is there a queue' is read, not guessed", async () => {
    const { store, calls } = fakeStore([row("a")]);
    await runScheduledPublishPass({
      store,
      publish: async () => published,
      now: NOW,
      cap: 5,
    });
    expect(calls.dueLimits).toEqual([6]);
  });

  /**
   * The cap is a share of the tick's 50-subrequest allowance, so it has to move
   * when the cost of a publish moves. Announcing made each published post spend
   * two more outbound writes — the announce createRecord and the putRecord that
   * writes its ref back — taking one post from four fetches to six, or seven on
   * a first-ever publish that also creates the publication.
   *
   * At five that is 5 x 7 = 35 of 50, leaving 15 for the five jobs that run
   * after this one — while the follower sample alone asks for up to 50. At three
   * it is 21, leaving 29. The number is pinned here because it is arithmetic
   * about a platform limit, not a preference: if a future change makes a publish
   * cheaper or dearer, this test is the thing that should fail.
   */
  it("defaults the cap to three, the share announcing left it", async () => {
    expect(MAX_PUBLISHES_PER_TICK).toBe(3);
    const FETCHES_PER_FIRST_PUBLISH = 7;
    const TICK_SUBREQUEST_BUDGET = 50;
    expect(MAX_PUBLISHES_PER_TICK * FETCHES_PER_FIRST_PUBLISH).toBe(21);
    // Headroom for everything downstream, the follower sample included.
    expect(
      TICK_SUBREQUEST_BUDGET -
        MAX_PUBLISHES_PER_TICK * FETCHES_PER_FIRST_PUBLISH,
    ).toBeGreaterThanOrEqual(29);
    const { store, calls } = fakeStore([row("a")]);
    await runScheduledPublishPass({
      store,
      publish: async () => published,
      now: NOW,
    });
    expect(calls.dueLimits).toEqual([MAX_PUBLISHES_PER_TICK + 1]);
  });
});

describe("retries end", () => {
  const transient: PublishAttempt = {
    ok: false,
    retry: true,
    reason: "Your data server couldn't take the post just now.",
  };

  it("hands a transient failure back to the next tick, with its reason recorded", async () => {
    const { store, calls } = fakeStore([row("a")]);
    const result = await runScheduledPublishPass({
      store,
      publish: async () => transient,
      now: NOW,
    });
    expect(calls.retried).toEqual([{ id: "a", reason: transient.reason }]);
    expect(calls.failed).toHaveLength(0);
    expect(result.retrying).toBe(1);
  });

  it("FAILS the post once the attempt ceiling is reached", async () => {
    // Two attempts already spent; this claim makes it the third.
    const { store, calls } = fakeStore([row("a", MAX_PUBLISH_ATTEMPTS - 1)]);
    const result = await runScheduledPublishPass({
      store,
      publish: async () => transient,
      now: NOW,
    });
    expect(calls.retried).toHaveLength(0);
    expect(result.failed).toBe(1);
    // The stored reason keeps the cause AND admits we stopped trying.
    expect(calls.failed[0].reason).toContain(transient.reason);
    expect(calls.failed[0].reason).toContain(
      `stopped trying after ${MAX_PUBLISH_ATTEMPTS} attempts`,
    );
  });

  it("counts the attempt at claim time, so an attempt that dies still spent one", async () => {
    const rows = [row("a")];
    const { store } = fakeStore(rows);
    await runScheduledPublishPass({
      store,
      publish: async () => {
        throw new Error("isolate evicted");
      },
      now: NOW,
    });
    expect(rows[0].attempts).toBe(1);
  });

  it("fails a non-retryable failure immediately — no ceiling to wait for", async () => {
    const { store, calls } = fakeStore([row("a")]);
    const revoked: PublishAttempt = {
      ok: false,
      retry: false,
      reason: "Goldroad couldn't use your connection to your data server.",
    };
    const result = await runScheduledPublishPass({
      store,
      publish: async () => revoked,
      now: NOW,
    });
    expect(result.failed).toBe(1);
    // Verbatim: nothing appended, because we did not "stop trying" — there was
    // nothing to try.
    expect(calls.failed).toEqual([{ id: "a", reason: revoked.reason }]);
  });

  it("retries a publisher that THREW rather than failing the post on a bug", async () => {
    const { store, calls } = fakeStore([row("a")]);
    const result = await runScheduledPublishPass({
      store,
      publish: async () => {
        throw new Error("boom");
      },
      now: NOW,
    });
    expect(result.retrying).toBe(1);
    expect(calls.retried[0].reason).toMatch(/try again/i);
  });
});

describe("nothing is stranded, and nothing accumulates", () => {
  it("hands back abandoned leases before reading what is due", async () => {
    const order: string[] = [];
    const { store } = fakeStore([row("a")]);
    const releaseStale = store.releaseStale;
    store.releaseStale = async (before, now) => {
      order.push("release");
      // The cutoff is one stale-claim window back from now.
      expect(now.getTime() - before.getTime()).toBe(STALE_CLAIM_MS);
      return releaseStale(before, now);
    };
    const due = store.due;
    store.due = async (now, limit) => {
      order.push("due");
      return due(now, limit);
    };
    await runScheduledPublishPass({
      store,
      publish: async () => published,
      now: NOW,
    });
    expect(order).toEqual(["release", "due"]);
  });

  it("a row whose bookkeeping throws does not cost the rows behind it", async () => {
    // The whole point of the per-row try: a rejecting D1 write used to exit the
    // loop, skipping every remaining due post for an hour.
    const { store, calls } = fakeStore([row("a"), row("b"), row("c")]);
    const published = store.published;
    store.published = async (id, rkey, now) => {
      if (id === "a") throw new Error("d1 write failed");
      return published(id, rkey, now);
    };
    const result = await runScheduledPublishPass({
      store,
      publish: async () => ({ ok: true, rkey: "3lyk73wxnok2f" }),
      now: NOW,
    });
    expect(result.errored).toBe(1);
    expect(calls.published.map((p) => p.id)).toEqual(["b", "c"]);
    expect(result.published).toBe(2);
  });

  it("prunes finished rows even when the publishing half fell over", async () => {
    const { store, calls } = fakeStore([row("a")]);
    store.due = async () => {
      throw new Error("d1 down");
    };
    const result = await runScheduledPublishPass({
      store,
      publish: async () => published,
      now: NOW,
    });
    expect(calls.pruned).toHaveLength(1);
    expect(result.pruned).toBe(true);
    expect(result.attempted).toBe(0);
  });

  it("survives a store that fails every call, and reports honestly", async () => {
    const broken: ScheduledPostStore = {
      due: async () => {
        throw new Error("nope");
      },
      claim: async () => {
        throw new Error("nope");
      },
      published: async () => {
        throw new Error("nope");
      },
      failed: async () => {
        throw new Error("nope");
      },
      retry: async () => {
        throw new Error("nope");
      },
      releaseStale: async () => {
        throw new Error("nope");
      },
      prune: async () => {
        throw new Error("nope");
      },
    };
    const result = await runScheduledPublishPass({
      store: broken,
      publish: async () => published,
      now: NOW,
    });
    expect(result).toMatchObject({
      attempted: 0,
      published: 0,
      failed: 0,
      pruned: false,
    });
  });
});

/**
 * Announce failures are collected, not swallowed, and not confused with publish
 * failures.
 *
 * The pass has one channel for "this post did not go out" — the row, in words
 * the writer reads — and it is the wrong one for "this post went out but its
 * announcement did not". Writing the second onto the row would make the posts
 * manager report a live post as broken, so the pass hands those sentences back
 * to its caller, which puts them on the operator alert list (~/lib/scheduled).
 */
describe("announce failures ride out separately", () => {
  const withProblem = (problem: string): PublishAttempt => ({
    ok: true,
    rkey: "3lyk73wxnok2f",
    announceProblem: problem,
  });

  it("collects the problem while still marking the row published", async () => {
    const { store, calls } = fakeStore([row("a")]);
    const result = await runScheduledPublishPass({
      store,
      publish: async () => withProblem("row a could not be announced"),
      now: NOW,
    });
    // The post went out. That is what the row says, and it is the truth.
    expect(calls.published).toEqual([{ id: "a", rkey: "3lyk73wxnok2f" }]);
    expect(calls.failed).toEqual([]);
    expect(result.published).toBe(1);
    expect(result.failed).toBe(0);
    // And the announce problem is still somebody's to hear about.
    expect(result.announceFailures).toEqual(["row a could not be announced"]);
  });

  it("stays empty when every announce did what it was asked", async () => {
    const { store } = fakeStore([row("a"), row("b")]);
    const result = await runScheduledPublishPass({
      store,
      publish: async () => published,
      now: NOW,
    });
    expect(result.published).toBe(2);
    expect(result.announceFailures).toEqual([]);
  });

  it("collects one per post rather than one per tick", async () => {
    const { store } = fakeStore([row("a"), row("b")]);
    const result = await runScheduledPublishPass({
      store,
      publish: async (post) => withProblem(`${post.id} could not be announced`),
      now: NOW,
    });
    expect(result.announceFailures).toEqual([
      "a could not be announced",
      "b could not be announced",
    ]);
  });

  it("never collects one for a post that failed to publish at all", async () => {
    // There is nothing to announce, and the writer is already being told the
    // real problem on their row.
    const { store, calls } = fakeStore([row("a")]);
    const result = await runScheduledPublishPass({
      store,
      publish: async () => ({
        ok: false as const,
        retry: false,
        reason: "Your data server refused the post.",
      }),
      now: NOW,
    });
    expect(calls.failed).toHaveLength(1);
    expect(result.announceFailures).toEqual([]);
  });
});
