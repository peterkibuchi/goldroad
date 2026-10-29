// @vitest-environment node

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { runAfterDeploy } from "./after-deploy.mjs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("runAfterDeploy", () => {
  const dir = mkdtempSync(join(tmpdir(), "after-deploy-"));
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => rmSync(dir, { recursive: true }));

  it("runs the command through the shell with RELEASE_SHA set", () => {
    const out = join(dir, "sha");
    expect(
      runAfterDeploy(`printf %s "$RELEASE_SHA" > "${out}"`, "abc123"),
    ).toBe(true);
    expect(readFileSync(out, "utf8")).toBe("abc123");
  });

  it("warns instead of throwing when the command fails", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(runAfterDeploy("exit 3", "abc123")).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("exit 3"));
  });
});
