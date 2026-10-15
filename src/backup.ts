/**
 * The backup exporter without the scheduler: `runBackup` reads every table
 * through `/run` and writes NDJSON through a `BackupSink` you provide.
 */
export { BACKUP_MODULE, BACKUP_SOURCE } from './adapters/tgcloud/entry.js';
export { type BackupSummary, runBackup, tableFileName } from './app/backup.js';
export type { BackupFile, BackupSink, Deps, Platform, RunEvent } from './app/ports.js';
