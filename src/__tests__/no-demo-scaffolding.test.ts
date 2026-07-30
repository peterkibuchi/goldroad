/**
 * Throwaway scaffolding must not reach the repository.
 *
 * Capturing screenshots of signed-in surfaces tempts you into edits that are
 * catastrophic if committed: replacing a null-session guard with a fabricated
 * writer so a page renders without signing in, or adding a scratch route to
 * host a preview. Both have happened here. A fabricated session is the worst
 * of them — it makes an unauthenticated visitor look signed in — and neither
 * shows up as a failing test, because the scaffolding is what makes things
 * pass.
 *
 * A scratch route also outlives its file: deleting `zz-preview.tsx` left its
 * import behind in the generated route tree, which builds only because the
 * tree is regenerated before compiling. That is a latent break sitting in a
 * committed file, so the generated tree is checked too.
 */

import { describe, expect, it } from "vitest";

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..");
const TESTS = join(SRC, "__tests__");

/** Every file under src/, excluding the tests themselves — this file names the
 * very strings it forbids, and fixtures legitimately use placeholder handles. */
function sourceFiles(dir: string = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (path === TESTS) continue;
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(path);
  }
  return out;
}

const relative = (path: string) => path.slice(SRC.length + 1);

describe("no demo scaffolding in source", () => {
  it("has no fabricated session identity", () => {
    const offenders = sourceFiles()
      .filter((path) => readFileSync(path, "utf8").includes("screenshotstub"))
      .map(relative);

    expect(
      offenders,
      `Fabricated session data left in: ${offenders.join(", ")}. A stubbed ` +
        `viewer makes an unauthenticated visitor look signed in. Delete the ` +
        `scaffolding and capture the screenshot with a real session.`,
    ).toEqual([]);
  });

  it("has no placeholder handle outside marketing mockups", () => {
    // sana.example is the fictional writer in the landing page's timeline card,
    // which is deliberate. Anywhere else it means a stubbed signed-in surface.
    const allowed = new Set(["routes/index.tsx"]);
    const offenders = sourceFiles()
      .filter((path) => !allowed.has(relative(path)))
      .filter((path) => readFileSync(path, "utf8").includes("sana.example"))
      .map(relative);

    expect(
      offenders,
      `Placeholder handle left in: ${offenders.join(", ")}. Outside the ` +
        `marketing mockup this is screenshot scaffolding — delete it.`,
    ).toEqual([]);
  });

  it("has no scratch routes", () => {
    const offenders = readdirSync(join(SRC, "routes")).filter((name) =>
      name.startsWith("zz-"),
    );

    expect(
      offenders,
      `Scratch routes present: ${offenders.join(", ")}. These ship as real, ` +
        `reachable URLs. Delete them before committing.`,
    ).toEqual([]);
  });

  it("has no scratch routes lingering in the generated route tree", () => {
    // Survives deletion of the route file itself, and only builds because the
    // tree is regenerated first — so it fails nothing until something reads it.
    const tree = readFileSync(join(SRC, "routeTree.gen.ts"), "utf8");

    expect(
      tree.includes("zz-"),
      "The generated route tree still references a zz- scratch route. " +
        "Re-run the dev server or build to regenerate it, then commit that.",
    ).toBe(false);
  });
});
