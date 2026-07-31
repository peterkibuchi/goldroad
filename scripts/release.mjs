#!/usr/bin/env node
/**
 * Cut a CalVer release: `vYYYY.MM.DD.NN`.
 *
 * WHY THE COUNTER IS ZERO-PADDED, because it looks like a cosmetic choice and
 * is not. GitHub sorts releases by TAG NAME, not by date, and a four-segment
 * CalVer is not parseable as semver — so it falls back to a string comparison,
 * where "9" sorts above "14" because '9' > '1'. On a day with ten or more
 * releases the list reads newest-last, which is worse than useless: it looks
 * like the newest thing shipped hours ago. Two digits make string order and
 * chronological order the same thing up to 99 releases in a day, which is more
 * than we will ever want.
 *
 * The date is the maintainer's local day (see RELEASE_TZ below), and ordering is
 * protected by an explicit guard rather than by the choice of clock.
 *
 * Notes come from GitHub's own generator against the previous tag, deliberately:
 * release notes are a CHANGELOG for users, assembled from merged PR titles, not
 * a place to restate reasoning that belongs in the commits.
 *
 * WHAT THIS DOES, in order: pushes `main` to the `release` branch — which is
 * the production channel and therefore the actual deploy — then tags and writes
 * the GitHub release. Deploy before stamp, so a version never claims to be live
 * before it is.
 *
 * Usage: pnpm release            (deploys, then cuts the next counter for today)
 *        pnpm release --dry-run  (prints the tag it would cut, touches nothing)
 */
import { execFileSync } from "node:child_process";

const dryRun = process.argv.includes("--dry-run");

/** Run a command, returning trimmed stdout. Throws with stderr attached, so a
 * failure says what went wrong rather than just exiting non-zero. */
function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8" }).trim();
  } catch (err) {
    const detail = err.stderr?.toString().trim() || err.message;
    throw new Error(`${cmd} ${args.join(" ")}\n${detail}`);
  }
}

/**
 * The release timezone. A CalVer tag is read by people, not machines — nothing
 * in the build parses it — so it should say the day its author was living in.
 * Stamping UTC put every late-night session on the previous date: work done
 * after 03:00 EAT is a new day here and yesterday in UTC, which is how one
 * calendar date collected thirty-four releases across two nights.
 *
 * The original rationale was that "which day is it" must not depend on who runs
 * this. That protects tag ordering, and the guard below protects it directly
 * instead — which is the better place for it, because it holds no matter what
 * clock or zone the machine has.
 */
const RELEASE_TZ = "Africa/Nairobi";
const datePart = new Intl.DateTimeFormat("en-CA", {
  timeZone: RELEASE_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
})
  .format(new Date())
  .replaceAll("-", ".");
const prefix = `v${datePart}`;

run("git", ["fetch", "--tags", "--quiet"]);

/**
 * Tags must never go backwards. Whatever clock produced `datePart`, a new tag
 * that sorts below the newest existing one would break the "latest release" any
 * lexicographic reader picks — including GitHub's own releases list, which is
 * what sent an older tag to the top of that page once already.
 */
const newest = run("git", ["tag", "--list", "v20*"])
  .split("\n")
  .filter(Boolean)
  .sort()
  .at(-1);
// `v2026.08.01.02` → `2026.08.01`. Dot-separated, zero-padded, fixed width, so
// string comparison is date comparison.
const newestDate = newest?.slice(1, 11);
if (newestDate && newestDate > datePart) {
  throw new Error(
    `Refusing to cut ${prefix}: ${newest} is already newer. The clock or the ` +
      `timezone (${RELEASE_TZ}) is wrong, and a tag that sorts backwards breaks ` +
      `every lexicographic "latest release" reader.`,
  );
}

const existing = run("git", ["tag", "--list", `${prefix}*`])
  .split("\n")
  .filter(Boolean);

/**
 * Highest counter already used today. Tolerates the unpadded tags cut before
 * this script existed (`.9`) and the bare same-day tag (`v2026.07.31`), so the
 * first padded release of a day still lands above them chronologically.
 */
const highest = existing.reduce((max, tag) => {
  const rest = tag.slice(prefix.length);
  if (rest === "") return Math.max(max, 0);
  const n = Number.parseInt(rest.replace(/^\./, ""), 10);
  return Number.isNaN(n) ? max : Math.max(max, n);
}, 0);

const tag = `${prefix}.${String(highest + 1).padStart(2, "0")}`;
const previous =
  existing
    .sort((a, b) => {
      const na =
        Number.parseInt(a.slice(prefix.length).replace(/^\./, ""), 10) || 0;
      const nb =
        Number.parseInt(b.slice(prefix.length).replace(/^\./, ""), 10) || 0;
      return na - nb;
    })
    .at(-1) ?? run("git", ["describe", "--tags", "--abbrev=0"]);

if (dryRun) {
  console.log(`would cut ${tag} (previous: ${previous})`);
  process.exit(0);
}

// Refuse to release anything but a clean, pushed main — a tag pointing at a
// commit nobody else has is a reference to nothing.
const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
if (branch !== "main") throw new Error(`on ${branch}, not main`);
if (run("git", ["status", "--porcelain"]) !== "")
  throw new Error("working tree is dirty");
if (run("git", ["rev-list", "--count", "origin/main..HEAD"]) !== "0")
  throw new Error("main has commits that are not pushed");

// Deploy FIRST, then stamp it. `release` is the production channel
// (wrangler.jsonc) — pushing it is what ships. Tagging before that would mint a
// version that claims to be live and is not, and the first version of this
// script did exactly that: it cut v2026.07.31.15 while production still served
// the commit before it.
run("git", ["push", "--quiet", "origin", "main:release"]);

run("git", ["tag", "-a", tag, "-m", tag]);
run("git", ["push", "--quiet", "origin", tag]);

const notes = run("gh", [
  "api",
  "repos/peterkibuchi/goldroad/releases/generate-notes",
  "-f",
  `tag_name=${tag}`,
  "-f",
  `previous_tag_name=${previous}`,
  "--jq",
  ".body",
]);
run("gh", ["release", "create", tag, "--title", tag, "--notes", notes]);
console.log(tag);
