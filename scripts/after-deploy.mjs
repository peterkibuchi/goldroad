/**
 * The release script's optional after-deploy hook: a shell command read from
 * this clone's git config, so a maintainer can kick off whatever checks a fresh
 * deploy (a production smoke test, say) without the repo knowing about it.
 *
 *   git config release.afterDeploy 'echo "released $RELEASE_SHA"'
 *
 * Unset is the default and does nothing. The command runs through the shell
 * with RELEASE_SHA (the released commit) in its environment.
 */
import { execFileSync, spawnSync } from "node:child_process";

/** The configured hook, or null when there is none. */
export function afterDeployCommand() {
  try {
    const command = execFileSync(
      "git",
      ["config", "--get", "release.afterDeploy"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return command || null;
  } catch {
    // `git config --get` exits 1 for an unset key.
    return null;
  }
}

/**
 * Runs the hook and reports whether it succeeded. It never throws: by the time
 * it runs the deploy has happened and the release exists, so a failing hook is
 * a warning about the hook, not a reason to fail a release that is already
 * live.
 */
export function runAfterDeploy(command, sha) {
  const res = spawnSync(command, {
    shell: true,
    stdio: "inherit",
    env: { ...process.env, RELEASE_SHA: sha },
  });
  if (res.status === 0) return true;
  const why = res.error?.message ?? `exit ${res.status ?? res.signal}`;
  console.warn(
    `warning: the after-deploy hook failed (${why}). The release itself is live; run the hook by hand if you need it.`,
  );
  return false;
}
