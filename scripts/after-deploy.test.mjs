// @vitest-environment node

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { afterDeployCommand, runAfterDeploy } from "./after-deploy.mjs";
import { execFileSync } from "node:child_process";
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

describe("afterDeployCommand", () => {
  const dir = mkdtempSync(join(tmpdir(), "after-deploy-repo-"));
  execFileSync("git", ["init", "--quiet", dir]);
  const git = (...args) => execFileSync("git", ["-C", dir, ...args]);
  // Point the lookup at the scratch repo, and keep the machine's own
  // global config (which may set the hook) out of it.
  vi.stubEnv("GIT_DIR", join(dir, ".git"));
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true });
  });

  it("is null when unset or blank", () => {
    expect(afterDeployCommand()).toBeNull();
    git("config", "release.afterDeploy", "  ");
    expect(afterDeployCommand()).toBeNull();
  });

  it("returns the configured command", () => {
    git("config", "release.afterDeploy", 'echo "$RELEASE_SHA"');
    expect(afterDeployCommand()).toBe('echo "$RELEASE_SHA"');
  });
});
