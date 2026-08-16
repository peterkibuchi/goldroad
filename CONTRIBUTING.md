# Contributing to Goldroad

Thanks for your interest in contributing. Goldroad is writer-owned publishing on
the AT Protocol, and it is open source so the platform can never lock anyone in —
including its own writers.

Please read [`AGENTS.md`](AGENTS.md) first: it is the contract for both humans and
AI agents and covers the stack, conventions, and security/trust rules.

## License & the DCO (no CLA)

Goldroad's core is licensed **AGPL-3.0-only** (see [`LICENSE`](LICENSE)). We accept
contributions under the **Developer Certificate of Origin (DCO)** — **there is no
CLA**. This is deliberate: no CLA means no single party can ever relicense the core
away from the commons.

What this means in practice:

- **Every commit must be signed off.** Add a `Signed-off-by` trailer with
  `git commit -s`. By signing off you certify the [DCO](https://developercertificate.org/) —
  that you wrote the patch or otherwise have the right to submit it under the
  project's license. Use a real name and a reachable email.
- Your contribution is licensed to the project and its users under **AGPL-3.0-only**.
  You retain your copyright; there is no copyright assignment.
- **AGPL implication for operators:** because there is no CLA, any deployment that
  includes outside contributions must offer its users the exact corresponding source
  of the running version (AGPL §13). Goldroad satisfies this structurally — the
  public repository is the deploy source (publish-before-deploy). Don't add code or
  dependencies that would make that impossible, and don't add dependencies whose
  licenses are incompatible with AGPL-3.0.

## Workflow

1. **Branch** from the latest `main`. No direct commits to `main`.
2. **Implement** in small, logically-scoped commits (Conventional Commits:
   `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`).
3. **Run the gate** — it must pass, and CI enforces the same:

   ```sh
   pnpm check       # Biome lint + format
   pnpm typecheck   # tsc --noEmit
   pnpm test        # Vitest
   pnpm build       # Workers bundle
   ```

4. **Sign off** every commit (`git commit -s`) and keep history linear (rebase onto
   `main`, don't merge `main` into your branch).
5. **Open a PR.** Keep it small and independently shippable. Describe what changed
   and why; link any issue.

## Review expectations

- The following get line-by-line human review: public API/route signatures, lexicon
  schemas & NSIDs (permanent!), auth/OAuth paths, payment code, DB migrations, and
  anything touching user data.
- PRs that touch `AGENTS.md`, `CLAUDE.md`, or CI workflows get byte-level review, and
  a CI check rejects invisible/non-printing Unicode in agent-instruction files.

## Reporting security issues

Do **not** open a public issue for a vulnerability. See [`SECURITY.md`](SECURITY.md).

## Code of conduct

Participating here means agreeing to the [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)
(Contributor Covenant 2.1). Report anything that breaches it to abuse@trygoldroad.com.
