# tgcloud-cron

[![CI](https://github.com/Peshkes/tgcloud-cron/actions/workflows/ci.yml/badge.svg)](https://github.com/Peshkes/tgcloud-cron/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/tgcloud-cron)](https://www.npmjs.com/package/tgcloud-cron)

Scheduled jobs for [Telegram Serverless](https://core.telegram.org/bots/serverless) bots.

Telegram Serverless runs bot code when an update arrives or a Mini App calls an
endpoint. It has no timer. tgcloud-cron lets you declare jobs in one file,
generates a free external trigger for them (GitHub Actions or Cloudflare Cron
Triggers), and on every tick runs the job on the platform. It also ships a
nightly database backup job, since the platform has no export.

> [!IMPORTANT]
> tgcloud-cron uses the undocumented management API of Telegram Serverless,
> reconstructed from the official CLI (`@tgcloud/cli` 0.2.0). It can change
> without notice. **Nothing has been verified against the live platform yet**:
> see [Verification status](https://github.com/Peshkes/tgcloud-cron#verification-status). This project is not
> affiliated with Telegram.

## Quickstart

In a Telegram Serverless project (the folder with `tgcloud/`):

```bash
npm install -D tgcloud-cron
npx tgcron init
```

This creates `tgcron.json` and an example job in `tgcloud/lib/cron/example.js`.
A job is a module with a default export:

```js
// tgcloud/lib/cron/dailyDigest.js
import { api, db } from 'sdk';
import { subscribers } from '../../schema.js';

export default async function (args, tick) {
  const chats = await db.select().from(subscribers).all();
  for (const c of chats) await api.sendMessage({ chat_id: c.chatId, text: 'Good morning' });
  return { sent: chats.length };
}
```

```json
{
  "jobs": {
    "dailyDigest": { "schedule": "0 9 * * *" },
    "backup": { "schedule": "30 2 * * *", "use": "tgcloud-cron/backup" }
  }
}
```

Deploy the job, then generate the workflow:

```bash
npx tgcloud push
npx tgcron generate github
```

Add the repository secret `TGCLOUD_TOKEN` (the CLI access token from
@BotFather: your bot > Serverless > CLI Access), commit
`.github/workflows/tgcron.yml` and push. Run a job by hand from the Actions tab
(tgcron > Run workflow) or locally:

```bash
TGCLOUD_TOKEN=app123:... npx tgcron run dailyDigest
```

A full project is in [examples/basic](https://github.com/Peshkes/tgcloud-cron/tree/main/examples/basic).

## How it works

```
 GitHub Actions schedule          tgcron tick --schedule "0 9 * * *"
 or Cloudflare Cron Trigger ───▶  1. GET  /app<id>/manage/get   deployed modules
                                  2. POST /app<id>/manage/run    deployed modules
                                                                 + synthetic endpoints/tgcron_entry
                                                                     │
                                                                     ▼
                                  Telegram Serverless isolate: entry imports
                                  lib/cron/dailyDigest.js and calls it with (args, tick)
```

- Jobs run the **deployed** code, as production does. `tgcron run <job> --local`
  sends your local files instead, for testing.
- The entry module that calls the job exists only inside the `/run` request.
  It is never deployed, so jobs are not reachable from your Mini App. Job
  modules must live under `lib/`, which the platform does not run on its own.
- Jobs that share a schedule run one after another. A failing job does not
  stop the next one.

## Configuration

`tgcron.json` at the project root, next to `tgcloud.jsonc`. Comments and
trailing commas are accepted. A JSON Schema ships with the package
(`"$schema": "./node_modules/tgcloud-cron/schema.json"`).

| Key | Default | Meaning |
| --- | --- | --- |
| `jobs.<name>` | | Letters, digits, `_` and `-`; starts with a letter. |
| `schedule` | required | Five-field cron expression, UTC. |
| `module` | `lib/cron/<name>` | Module to run, relative to `tgcloud/`, without `.js`. Must be under `lib/`. |
| `args` | `{}` | JSON object passed as the first argument. |
| `enabled` | `true` | `false` keeps the job out of generated triggers; `tgcron run` still works. |
| `use` | | `"tgcloud-cron/backup"` for the built-in backup job. |

The second argument of a job is `tick`: `{ job, runId, scheduledAt }`, where
`scheduledAt` is the ISO time the schedule was due, or `null` for a manual run.

### Cron syntax

`*`, values, ranges `1-5`, lists `1,15`, steps `*/15` and `0-30/10`, month
and weekday names (`JAN`, `MON-FRI`), `0` or `7` for Sunday. When both day
fields are set, a day matches if either does (standard cron).

Weekday numbers mean different days on the two targets: GitHub counts 0-6
from Sunday, Cloudflare 1-7 from Sunday. Write them as in standard cron;
`generate` translates the weekday field for each target (`1-5` becomes
`MON-FRI` for Cloudflare).

Not supported, because a target rejects them or reads them differently: `L`,
`W`, `#`, `?`, `@daily`, seconds, `5/10` (write `5-59/10`) and a step over all
weekdays such as `*/2` (list the days).

### Backup job

The export itself is [tgcloud-backup](https://github.com/Peshkes/tgcloud-cron/tree/main/packages/backup), which
also works on its own (`npx tgbackup export`).

```json
"backup": {
  "schedule": "30 2 * * *",
  "use": "tgcloud-cron/backup",
  "args": { "tables": ["subscribers", "orders"], "pageSize": 500 },
  "destination": { "type": "artifact", "retentionDays": 14 }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `args.tables` | all tables | Tables to export. By default read from `sqlite_master`. |
| `args.pageSize` | `500` | Rows per `/run` call. Halved automatically when a page hits a platform limit. |
| `destination` | `{ "type": "artifact", "retentionDays": 30 }` | A workflow artifact kept 1-90 days, or `{ "type": "branch", "branch": "tgcron-backups" }` to commit to a branch with no shared history. `main`, `master`, `gh-pages` and similar are refused. |

Output, in `tgcron-backup/<job>/<UTC timestamp>/`:

- `<table>.ndjson`: one JSON object per row. Bytes are written as
  `{"$base64": "..."}`, integers beyond 2^53 as `{"$bigint": "..."}`.
- `schema.js`: the deployed schema.
- `manifest.json`: app id, start and end time, row count and SHA-256 per file.

Only a backup that finished, with its `manifest.json`, is uploaded or
committed. Each page is a separate call, so the export is **not a
point-in-time snapshot**: rows written during the backup may or may not be
included. There is no restore command yet.

## CLI

| Command | |
| --- | --- |
| `tgcron init` | Create `tgcron.json` and `tgcloud/lib/cron/example.js`. Existing files are kept. |
| `tgcron check` | Validate the config, check that job modules exist, print the next three runs, and fail if a generated file is out of date. Offline. |
| `tgcron generate github` | Write `.github/workflows/tgcron.yml`. |
| `tgcron generate cloudflare [--name <worker>]` | Write a Worker project to `cloudflare/`. |
| `tgcron run <job> [--local] [--json]` | Run one job now. |
| `tgcron tick --schedule "<cron>" [--json]` | Run every enabled job with this schedule. The generated workflow calls this. |

Exit codes: `0` ok, `1` a job failed, `2` usage or config error, `3` auth
error, `4` transient error (network, 429, 5xx).

Environment: `TGCLOUD_TOKEN` (required for `run` and `tick`),
`TG_CLOUD_API_URL` and `TGCLOUD_BETA=1`, read the same way as by the official
CLI.

Every line of a run carries the job name and run id:

```
[dailyDigest 7f3a09c1] start   scheduled 2026-10-16T09:00:00.000Z, deployed code, revision 41
[dailyDigest 7f3a09c1]   log   sending to 42 chats  +12ms  [lib/cron/dailyDigest:18]
[dailyDigest 7f3a09c1] ok      {"sent":42}  platform 840ms, total 1.31s
```

`--json` prints the same events as JSON lines. In GitHub Actions a failed job
also gets an error annotation and a row in the run summary.

## Schedulers

### GitHub Actions

Free for public repositories and within the minutes quota for private ones.
The generated workflow has one `schedule:` entry per distinct expression and a
manual trigger with a job picker. Known limits of GitHub schedules:

- The shortest interval is 5 minutes; `tgcron` rejects faster schedules for
  this target.
- Runs often start several minutes late, more around the top of the hour.
  `tick.scheduledAt` is the time the run was due, not the time it started.
- In a public repository, scheduled workflows are disabled after 60 days
  without commits.

### Cloudflare Workers

```bash
npx tgcron generate cloudflare
cd cloudflare && npm install
npx wrangler secret put TGCLOUD_TOKEN
npx wrangler deploy
```

Cron Triggers fire on time and support one-minute schedules. The free plan
allows 5 Cron Triggers per account; `tgcron check` warns above that. Backup
jobs are not available on this target because a Worker has nowhere to write
files without extra storage bindings.

## Limits and caveats

- **Platform limits are not published.** Community measurements
  ([DaYzTm/telegram-serverless-limits](https://github.com/DaYzTm/telegram-serverless-limits),
  CLI 0.2.0) report about 3 s of CPU and 128 MiB of heap per call, about
  496 MiB of SQLite, and HTTP 429 from the management API at 16 parallel
  calls. A job has to fit in one call; split long work across runs.
- **At most once, not exactly once.** A `/run` that fails with a 5xx or a
  network error is not retried, because the job may already have run. A
  missed run is not caught up. Make jobs safe to skip.
- **Overlap.** On GitHub, runs of one schedule never overlap: a new run waits
  for the previous one, and a manual run of a job waits for its schedule's
  run. GitHub keeps only one waiting run per group, so if runs pile up, the
  older waiting ones are dropped. Cloudflare can overlap runs of a slow job.
- **Deployed code only.** A job that is in your repository but not pushed
  with `tgcloud push` fails with `module ... not found in the deployed code`.
- **Reserved names.** `endpoints/tgcron_entry` and `endpoints/tgbackup_export`
  are used for the synthetic modules; a project module with either name is
  an error.

## Security

The CLI access token (`app<id>:<secret>`) gives full control of the bot:
deploy, database migrations, and running arbitrary code next to the database.
There are no scoped or read-only tokens.

- tgcloud-cron reads the token only from the `TGCLOUD_TOKEN` environment
  variable. It never writes it to disk, never reads `.tgcloud/credentials`,
  and prints only the public `app<id>` part.
- Keep it in a CI secret (`secrets.TGCLOUD_TOKEN`, `wrangler secret put`).
  Anyone who can change workflows in the repository can read it.
- The generated workflow requests `contents: read`, or `contents: write` when a
  backup commits to a branch. Job names from the manual trigger reach the
  script through an environment variable, not by interpolation.
- Text from the server is stripped of control characters before printing.
- **Backups contain your users' data.** Telegram's developer terms (section 4)
  require you to protect it. Keep backups in a private repository, use the
  artifact destination with a short retention, or both. A branch in a public
  repository makes every row public.

Report vulnerabilities as described in [SECURITY.md](https://github.com/Peshkes/tgcloud-cron/blob/main/SECURITY.md).

## Verification status

Nothing has run against the live platform yet. The table of what is checked,
and how, is in the [repository README](https://github.com/Peshkes/tgcloud-cron#verification-status).

## FAQ

**Why not just call `npx tgcloud run` from a workflow?** That works for one
handler, but `tgcloud run` sends your checkout, not what is deployed, and it
can only run `handlers/` and `endpoints/` modules. A job in `endpoints/` is
callable by every Mini App user.

**Can a job write to the database?** Yes. It runs like a handler, with the
full `sdk`.

**What timezone do schedules use?** UTC, on both targets. Convert local times
yourself.

**What happens when Telegram adds native cron?** Use it. tgcloud-cron jobs are
plain modules with a default export and should move over with small changes.

**Why no third-party dependencies?** The only dependencies are
`tgcloud-api` and `tgcloud-backup` from the same repository. The cron parser is
under 300 lines, JSON with comments takes 50, and Node has `fetch` and
`parseArgs`. Fewer packages means fewer things that can read your token.

**Does it work with another scheduler?** The package exports `runTick`; any
scheduler that can run Node 18+ or a Worker can call it with a
`TgcloudClient` from `tgcloud-api`. Only GitHub and Cloudflare have generators.

## Development

See the [repository](https://github.com/Peshkes/tgcloud-cron) and [CONTRIBUTING.md](https://github.com/Peshkes/tgcloud-cron/blob/main/CONTRIBUTING.md).

## License

[MIT](LICENSE)
