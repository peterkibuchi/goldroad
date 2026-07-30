// @vitest-environment node

import { describe, expect, it } from "vitest";

import * as dashboard from "../routes/dashboard";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The Posts page stopped carrying analytics.
 *
 * It used to end with a thin "Readers" strip: a total, a flat list of per-post
 * view counts, and an honesty line. That strip was thin because the page it
 * lived on has a different job — Posts is a work surface, where every element is
 * an affordance for acting on a specific post, and analytics arrives with no
 * intent at all. The depth moved to /stats, which is built for the open question.
 *
 * The rules this locks in: Posts renders from the data server read it already
 * does, and a slow or dead analytics upstream can never touch the page a writer
 * publishes from.
 */
const source = readFileSync(
  fileURLToPath(new URL("../routes/dashboard.tsx", import.meta.url)),
  "utf8",
);

describe("the Posts page carries no analytics", () => {
  it("no longer exports the Readers strip", () => {
    expect("ReadersSection" in dashboard).toBe(false);
  });

  it("makes no analytics request at all", () => {
    expect(source).not.toContain("/api/stats");
  });

  it("keeps the page's own actions — Delete still lives here", () => {
    expect(typeof dashboard.DeletePostForm).toBe("function");
  });
});
