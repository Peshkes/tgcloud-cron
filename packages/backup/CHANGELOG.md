# Changelog

All notable changes to tgcloud-backup are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-15

### Added

- `runBackup`: exports every table to NDJSON with `schema.js` and a
  manifest, paging by rowid within the platform's limits.
- `tgbackup export` CLI.
- `directorySink` for writing to disk.

[Unreleased]: https://github.com/Peshkes/tgcloud-cron/compare/tgcloud-backup@0.1.0...HEAD
[0.1.0]: https://github.com/Peshkes/tgcloud-cron/releases/tag/tgcloud-backup@0.1.0
