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
 *  - a lease nobody is holding is handed back rather than stranding the post;
 *  - a retry publishes under the key the first claim reserved, so it finds an
 *    attempt that landed instead of publishing again.
 */

const NOW = Date.parse("2026-08-04T09:00:00.000Z");

type Row = {
  id: string;
  did: string;
  draftId: string;
  attempts: number;
  claimed: boolean;
  rkey: string | null;
};

/** A store over plain objects, recording the terminal writes. */
function fakeStore(rows: Row[]) {
  const calls = {
    published: [] as string[],
    failed: [] as Array<{ id: string; reason: string }>,
    retried: [] as Array<{ id: string; reason: string }>,
    releasedStale: 0,
    dueLimits: [] as number[],
  };
  const store: ScheduledPostStore = {
    async due(_now, limit) {
      calls.dueLimits.push(limit);
      return rows
        .filter((row) => !row.claimed)
        .slice(0, limit)
        .map(({ id, did, draftId }) => ({ id, did, draftId }));
    },
    async claim(id, _now, rkey) {
      const row = rows.find((r) => r.id === id);
      if (!row || row.claimed) return null;
      row.claimed = true;
      row.attempts += 1;
      row.rkey ??= rkey;
      return { attempts: row.attempts, rkey: row.rkey };
    },
    async published(id) {
      calls.published.push(id);
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
    rkey: null,
  };
}

/** Mints distinct keys, so a test can tell a reserved key from a fresh one. */
let minted = 0;
const mintRkey = () => `3lyk73wxnok${(minted++).toString().padStart(2, "0")}`;

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
    const result = await runScheduledPublishPass({
      mintRkey,
      store,
      publish,
      now: NOW,
    });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(calls.published).toEqual(["a"]);
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
    const result = await runScheduledPublishPass({
      mintRkey,
      store,
      publish,
      now: NOW,
    });
    expect(publish).not.toHaveBeenCalled();
    expect(result.contended).toBe(1);
    expect(result.attempted).toBe(0);
    expect(calls.failed).toHaveLength(0);
    expect(calls.retried).toHaveLength(0);
  });

  it("never publishes the same row twice within a tick", async () => {
    const { store } = fakeStore([row("a")]);
    const publish = vi.fn(async () => published);
    await runScheduledPublishPass({
      mintRkey,
      store,
      publish,
      now: NOW,
    });
    await runScheduledPublishPass({
      mintRkey,
      store,
      publish,
      now: NOW,
    });
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
      mintRkey,
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
      mintRkey,
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
      mintRkey,
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
      mintRkey,
      store,
      publish: async () => published,
      now: NOW,
      cap: 5,
    });
    expect(calls.dueLimits).toEqual([6]);
  });

  it("defaults the cap to five", async () => {
    expect(MAX_PUBLISHES_PER_TICK).toBe(5);
    const { store, calls } = fakeStore([row("a")]);
    await runScheduledPublishPass({
      mintRkey,
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
      mintRkey,
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
      mintRkey,
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
      mintRkey,
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
      mintRkey,
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
      mintRkey,
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
      mintRkey,
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
    store.published = async (id) => {
      if (id === "a") throw new Error("d1 write failed");
      return published(id);
    };
    const result = await runScheduledPublishPass({
      mintRkey,
      store,
      publish: async () => ({ ok: true, rkey: "3lyk73wxnok2f" }),
      now: NOW,
    });
    expect(result.errored).toBe(1);
    expect(calls.published).toEqual(["b", "c"]);
    expect(result.published).toBe(2);
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
    };
    const result = await runScheduledPublishPass({
      mintRkey,
      store: broken,
      publish: async () => published,
      now: NOW,
    });
    expect(result).toMatchObject({
      attempted: 0,
      published: 0,
      failed: 0,
    });
  });
});

describe("a retry can't publish twice", () => {
  it("hands the publisher the key the claim reserved", async () => {
    const { store } = fakeStore([row("a")]);
    const publish = vi.fn(async () => published);
    await runScheduledPublishPass({ mintRkey, store, publish, now: NOW });
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a", rkey: expect.any(String) }),
    );
  });

  it("gives every retry of a row the first attempt's key", async () => {
    const rows = [row("a")];
    const { store } = fakeStore(rows);
    const keys: string[] = [];
    const publish = async (post: { rkey: string }) => {
      keys.push(post.rkey);
      // The write landed but the answer was lost: from here, a timeout.
      throw new Error("timed out");
    };
    for (let tick = 0; tick < 2; tick++) {
      await runScheduledPublishPass({ mintRkey, store, publish, now: NOW });
      rows[0].claimed = false; // released for the next tick
    }
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });
});
