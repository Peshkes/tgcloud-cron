# Changelog

All notable changes to tgcloud-api are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-15

### Added

- `TgcloudClient` with `getDeployed` (`GET /get`) and `run` (`POST /run`),
  reconstructed from `@tgcloud/cli` 0.2.0.
- Typed errors (`ApiError.kind`), retries for transient errors, and
  `idempotent` runs.
- `withModules` and `baseUrlFromEnv`.

[Unreleased]: https://github.com/Peshkes/tgcloud-cron/compare/tgcloud-api@0.1.0...HEAD
[0.1.0]: https://github.com/Peshkes/tgcloud-cron/releases/tag/tgcloud-api@0.1.0
