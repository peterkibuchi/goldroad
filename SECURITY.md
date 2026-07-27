# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities **privately** — do not open a public issue,
pull request, or discussion for anything security-sensitive.

- Email: **security@trygoldroad.com** (abuse and content reports:
  **abuse@trygoldroad.com**).
- Alternatively, use GitHub's private
  [Report a vulnerability](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
  flow on this repository.

Please include enough detail to reproduce: affected version/commit, a description of
the issue and its impact, and reproduction steps or a proof of concept if you have
one. We aim to acknowledge reports within a few business days.

Please act in good faith: give us reasonable time to remediate before any public
disclosure, and avoid privacy violations, data destruction, or service degradation
while investigating.

## Supported versions

Goldroad is a continuously-deployed web application; the hosted service always runs
the latest published `release`. Security fixes are applied to the current released
version — there are no long-term maintenance branches for older versions. If you run
a self-hosted instance, track the latest release (see [`SELF_HOSTING.md`](SELF_HOSTING.md)).

## Handling secrets

Secrets never live in the repository. They are stored in Cloudflare Worker secret
stores and, for local development, in `.dev.vars` (gitignored). The `.env.example`
and `.dev.vars.example` files document *key names only*. If you believe a secret has
been exposed, treat it as compromised: rotate it first (removing it from history does
not invalidate a leaked key), then report per the process above.
