# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/Peshkes/tgcloud-cron/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Peshkes/tgcloud-cron/releases/tag/v0.1.0
