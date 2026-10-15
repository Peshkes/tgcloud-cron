# tgcloud-backup

[![npm](https://img.shields.io/npm/v/tgcloud-backup)](https://www.npmjs.com/package/tgcloud-backup)

Exports every table of a [Telegram Serverless](https://core.telegram.org/bots/serverless)
bot to NDJSON. The platform keeps the bot's SQLite database and has no export
API; this reads it through the same management API the official CLI uses.

> [!IMPORTANT]
> The management API is undocumented and was reconstructed from
> `@tgcloud/cli` 0.2.0. It can change without notice, and nothing here has
> been verified against the live platform yet. Not affiliated with Telegram.

## Usage

```bash
TGCLOUD_TOKEN=app123:... npx tgbackup export
```

```
[backup] exporting app123 to tgcloud-backup/2026-10-16T02-30-00Z
[backup] found 3 table(s): orders, prices, subscribers
[backup] orders: 1250 row(s)
[backup] prices: 2 row(s)
[backup] subscribers: 418 row(s)
[backup] done: 1670 row(s) from 3 table(s) in tgcloud-backup/2026-10-16T02-30-00Z
```

| Option | Default | |
| --- | --- | --- |
| `--out <dir>` | `tgcloud-backup` | Parent directory; each run writes to `<dir>/<UTC timestamp>/`. |
| `--tables <a,b>` | all tables | Export only these. |
| `--page-size <n>` | `500` | Rows per call, 1-10000. Halved automatically when a page hits a platform limit. |
| `--json` | | Progress as JSON lines. |

The token is the CLI access token from @BotFather (your bot > Serverless >
CLI Access), read only from `TGCLOUD_TOKEN`. `TG_CLOUD_API_URL` and
`TGCLOUD_BETA=1` work as in the official CLI. Exit codes: `0` ok, `1` export
failed, `2` usage error, `3` auth error, `4` transient error.

To run it on a schedule, use [tgcloud-cron](https://github.com/Peshkes/tgcloud-cron/tree/main/packages/cron)
with `"use": "tgcloud-cron/backup"`.

## Output

| File | |
| --- | --- |
| `<table>.ndjson` | One JSON object per row. Bytes are `{"$base64": "..."}`, integers beyond 2^53 are `{"$bigint": "..."}`. |
| `schema.js` | The deployed `tgcloud/schema.js`. |
| `manifest.json` | App id, start and end time, and for each file its table, row count, size and SHA-256. |

A table name that is not safe as a file name (SQLite allows almost any text)
is rewritten, for example `my table` becomes `my_table.ndjson`; the manifest
maps every file back to its table.

## How it works

Each call to `POST /app<id>/manage/run` sends the deployed modules plus a
small exporter module, `endpoints/tgbackup_export`, that exists only inside
the request and is never deployed. The exporter lists tables from
`sqlite_master` and returns one page of rows per call, ordered by rowid, so a
call stays within the platform's CPU and memory limits (about 3 s and
128 MiB, as measured by the community). Tables without a rowid are paged by
offset.

- **Read-only.** The exporter runs only `SELECT` statements.
- **Not a snapshot.** Pages are separate calls, so rows written during the
  export may or may not be included. The manifest records when it started
  and ended.
- **Personal data.** A backup holds your users' data. Telegram's developer
  terms (section 4) require you to protect it; do not commit it to a public
  repository.

## Library

```js
import { TgcloudClient } from 'tgcloud-api';
import { directorySink, runBackup } from 'tgcloud-backup';

const platform = new TgcloudClient({ token: process.env.TGCLOUD_TOKEN, fetch });
const summary = await runBackup({
  platform,
  sink: directorySink('backups/today'),
  tables: ['subscribers'],
  onProgress: console.log,
});
```

`runBackup` writes through a `BackupSink`, so files can go anywhere: implement
`open(name)` returning `append(text)` and `close()`.

## License

[MIT](LICENSE)
