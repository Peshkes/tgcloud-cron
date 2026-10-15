# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-10-15

### Changed

- The management API client and the backup exporter moved to the new
  packages `tgcloud-api` and `tgcloud-backup`, which tgcloud-cron now depends
  on. `tgcron.json` is unchanged.
- A job that fails with a server or network error no longer stops the other
  jobs of the same tick; only a rejected token does.
- A manual run of a job shares the concurrency group of the job's schedule.
- Backups for the same branch are committed in one step, and a rejected push
  is retried from the new branch tip.
- The generated Worker has no public URL (`workers_dev: false`).

### Fixed

- Weekdays on Cloudflare: Cloudflare counts 1-7 from Sunday, so `1-5` ran
  Sunday to Thursday. Generated configs now spell weekdays for each target,
  and a step over all weekdays (`*/2`) is rejected as ambiguous.
- Backups skipped rows with a rowid of zero or below, broke on tables with
  their own `rowid` column, lost precision above 2^53, and failed on
  `WITHOUT ROWID` tables named in `args.tables`.
- A table name from the database could write a backup file outside the
  backup directory.
- Partial backups were uploaded or committed after a failed run.
- Backup branch names that git or GitHub treat specially (`-x`, `main`,
  `gh-pages`) were accepted.
- A job's return value could print lines that GitHub reads as workflow
  commands.
- `tgcron.json` saved with a byte order mark failed to parse.

### Added

- `TGCLOUD_BETA=1` support, as in the official CLI.
- Network errors name the host that could not be reached.

## [0.1.0] - 2026-10-15

### Added

- `tgcron.json` config with module jobs and the built-in `tgcloud-cron/backup` job.
- Five-field cron parser (UTC) with next and previous fire time calculation.
- `tgcron init`, `check`, `generate github`, `generate cloudflare`, `run` and `tick`.
- GitHub Actions workflow generator, with backups uploaded as artifacts or
  committed to a separate branch.
- Cloudflare Workers project generator and the `tgcloud-cron/worker` entry.
- Management API client for `/get` and `/run`, reconstructed from
  `@tgcloud/cli` 0.2.0, with contract tests on reconstructed fixtures.
- `npm run verify:live` to check API assumptions against a real bot.

[Unreleased]: https://github.com/Peshkes/tgcloud-cron/compare/tgcloud-cron@0.2.0...HEAD
[0.2.0]: https://github.com/Peshkes/tgcloud-cron/compare/v0.1.0...tgcloud-cron@0.2.0
[0.1.0]: https://github.com/Peshkes/tgcloud-cron/releases/tag/v0.1.0
