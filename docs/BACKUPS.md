# Backups and restore

D1 holds data that exists nowhere else. Published posts are safe — they live in
each writer's own atproto repository and can be re-read from their PDS — but the
launch-updates email list, private drafts, the import ledger, follower-count
history, and OAuth session rows are ours alone. Losing them loses them
permanently.

Two mechanisms cover that, and they cover different things.

## 1. Time Travel — already on, nothing to configure

Every D1 database has a 30-day point-in-time restore built in, on every plan.
It is the right tool for the failure modes that actually happen: a migration
that drops the wrong column, a `DELETE` without a `WHERE`, a backfill that
corrupts a column. There is no setup and no cost.

Find a restore point:

```sh
pnpm wrangler d1 time-travel info goldroad-db
pnpm wrangler d1 time-travel info goldroad-db --timestamp 2026-07-29T02:00:00Z
```

Restore, by timestamp or by bookmark (exactly one, not both):

```sh
pnpm wrangler d1 time-travel restore goldroad-db --timestamp 2026-07-29T02:00:00Z
pnpm wrangler d1 time-travel restore goldroad-db --bookmark 00000085-00000000-00004c1f-...
```

Timestamps take a Unix seconds value or RFC3339, and **must be within the last
30 days** — wrangler rejects anything older, or in the future. Both commands act
on the remote database.

Restoring is itself a write, so the state you restored *from* is also inside the
window: an unwanted restore can be walked back for the next 30 days.

### What Time Travel does not cover

Three gaps, all narrow, all fatal:

- **It lives inside the database.** Delete the database — or lose access to the
  account — and its 30 days of history go with it.
- **It restores in place.** There is no way to get the bytes out, to inspect a
  dump, to diff two points in time, or to move to another provider.
- **Nothing older than 30 days exists.** A problem noticed on day 31 is
  unrecoverable.

Section 2 exists only for those.

## 2. Nightly off-platform export

`.github/workflows/backup.yml` runs daily at 03:20 UTC. It exports the
production database, verifies the dump is real, encrypts it, uploads it as a
workflow artifact, and then records a row in `backup_runs`.

It runs in CI rather than in the Worker cron for two reasons: D1's export is an
account-scoped REST operation that needs an account API token (which has no
business being in a Worker), and it is polled to completion, which no cron
invocation's CPU budget allows.

**The dump is encrypted to a public key before it is uploaded, and the job fails
rather than uploading plaintext.** Workflow artifacts on a public repository are
downloadable by anyone. This dump contains OAuth refresh tokens, private drafts,
and the email list. Encrypting to a public key means CI can write backups it
cannot itself read.

### The heartbeat

The most common way a backup fails is silently: the job stops running, and
nothing looks wrong until a restore is attempted. So the export stamps a
`backup_runs` row **only after** a verified, encrypted, uploaded dump, and the
hourly Worker cron (`src/lib/backup.ts`, wired into `src/lib/scheduled.ts`)
checks that row every hour. It complains — through the same `WEBHOOK_URL` alert
path as the existing self-check — when the newest backup is:

- missing entirely,
- older than 48 hours (two nightly runs; one missed run is a blip, two is a
  pattern),
- suspiciously small, which catches the export that "succeeded" and wrote almost
  nothing,
- or dated in the future, which would otherwise pin the check to healthy forever.

Set `WEBHOOK_URL` as a Worker secret to actually be told. Without it the check
still runs and still logs; it just has nobody to tell.

## Owner setup — one time

**1. Generate the backup keypair.** Do this on your own machine, not in CI:

```sh
age-keygen -o goldroad-backup.key
```

It prints the public key (`age1…`). Keep `goldroad-backup.key` somewhere you
will still have it after losing this laptop — a password manager is fine. **If
you lose the secret key, every backup encrypted to it is unreadable.** It is the
one piece of this that has no recovery path.

**2. Add the public key as a repository variable** named
`BACKUP_AGE_RECIPIENT`, set to the `age1…` public key. This is a public key, so
it is a variable rather than a secret. The workflow refuses to run without it.

**3. Add two repository secrets:**

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | An account-scoped API token with D1 edit permission |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID |

The token needs to both read (export) and write (stamp the heartbeat row) D1.
Create it from Cloudflare's API-token screen following
[Cloudflare's current instructions](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)
— the dashboard's layout and labels change, so follow that page rather than a
transcription of it here. Scope the token to D1 only; it does not need anything
else.

**4. Apply the migration** that creates `backup_runs`, or the heartbeat step
will fail:

```sh
pnpm db:migrate:prod
```

**5. Run it once by hand** to confirm the whole chain works, rather than finding
out at 03:20. Trigger the `Backup` workflow manually, then check the run
produced an artifact and that the row landed:

```sh
pnpm wrangler d1 execute goldroad-db --remote \
  --command "SELECT * FROM backup_runs ORDER BY at DESC LIMIT 5;"
```

## Restoring

### From Time Travel — the usual case

Use section 1. This is what you want for a bad migration or a bad delete: it is
faster, it needs no keys, and it loses nothing.

### From an encrypted dump — database is gone, or you need >30 days

Download the artifact from the workflow run, then:

```sh
age --decrypt --identity goldroad-backup.key \
  --output d1-dump.sql d1-dump.sql.age
```

Into a fresh database:

```sh
pnpm wrangler d1 create goldroad-db-restored
pnpm wrangler d1 execute goldroad-db-restored --remote --file d1-dump.sql
```

Then point `database_id` in `wrangler.jsonc` at the restored database and
deploy. Importing over an existing populated database will collide on primary
keys — restore into an empty one.

Note that restored OAuth session rows may be stale, so writers may need to sign
in again. That is a nuisance, not data loss.

## Known limits

Stated plainly, because a backup you have wrong assumptions about is worse than
one you know the edges of:

- **Artifact retention is 90 days**, the ceiling this plan allows. That is longer
  than Time Travel's 30 days, which is the point — but it is a rolling window,
  not an archive. If you want a copy you keep forever, download one periodically
  and store it yourself. Nothing automates that here, because doing it for free
  and off-platform would mean putting credentials for some third party into CI.
- **This is a nightly snapshot.** Up to 24 hours of writes can be lost if it is
  the only surviving copy. Time Travel covers that window in every scenario
  except the database itself being destroyed.
- **Cloudflare R2 would be the correct home for these dumps** — versioned,
  lifecycle-managed, no 90-day ceiling. It requires a payment card on file even
  within its free allowance, so it is deliberately not used here. If that
  changes, moving the upload step to R2 is a small change and the right one.
- **The secret key is a single point of failure.** There is no key escrow. Losing
  it makes every artifact permanently unreadable.
