---
name: verify
description: Run this project's gate (pnpm gate — check with error-on-warnings, typecheck, test) and report evidence. Use after completing any code change, before every commit, and whenever asked "does it work?" — never claim done without it.
---

# /verify — the gate, with evidence

`pnpm gate` = `check --error-on-warnings && typecheck && test`. Run it from the repo root.

- **Evidence, not assertions.** Report the actual tail of the output (pass counts, error
  text). "Done" without output is not done.
- A red step stops the ladder: fix, then re-run `pnpm gate` from the top.
- `pnpm build` only pre-PR or when build/Worker config changed — CI builds on every PR.
- Touched the schema? `pnpm db:generate` and check the migration in `drizzle/` before
  committing; never hand-edit applied migrations.
- **Third occurrence of the same failure class:** promote it to infrastructure (Biome
  rule, hook, CI step, test) rather than fixing it a fourth time by hand.
- **Visual verification is for visual work, at checkpoints** — not every edit, never for
  logic-only changes. Shots go to gitignored `.agents/evidence/`, get linked into the PR
  via `evidence-upload`, and are pruned after merge. Never commit them.
