<!-- What changed, and why. Link any issue. Keep it small and independently shippable. -->

## Checklist

- [ ] `pnpm gate` exits 0 (lint, typecheck, tests) — and `pnpm build` for anything that touches the bundle
- [ ] Tests added for behaviour that changed, and they fail without the change
- [ ] Every commit is signed off (`git commit -s`) — contributions are DCO-only, no CLA

<!--
Line-by-line human review is required for: public API/route signatures, lexicon
schemas & NSIDs (permanent), auth/OAuth paths, payment code, DB migrations, and
anything touching user data. See CONTRIBUTING.md.
-->
