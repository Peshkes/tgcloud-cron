import type { Deployed, LogEntry, RunResult } from '../adapters/tgcloud/client.js';

/** The subset of the management API client the use cases need. */
export interface Platform {
  readonly appId: string;
  getDeployed(): Promise<Deployed>;
  run(
    module: string,
    sources: Readonly<Record<string, string>>,
    args: Record<string, unknown>,
    options?: { idempotent?: boolean },
  ): Promise<RunResult>;
}

/** Where a backup's files go. Implemented by the CLI with the file system. */
export interface BackupSink {
  /** Directory the backup is written to, for messages. */
  readonly location: string;
  open(path: string): BackupFile;
}

export interface BackupFile {
  append(text: string): Promise<void>;
  close(): Promise<{ bytes: number; sha256: string }>;
}

export type RunEvent =
  | {
      readonly type: 'start';
      readonly job: string;
      readonly runId: string;
      readonly scheduledAt: string | null;
      readonly code: 'deployed' | 'local';
      readonly revision?: number;
    }
  | { readonly type: 'log'; readonly job: string; readonly runId: string; readonly entry: LogEntry }
  | {
      readonly type: 'progress';
      readonly job: string;
      readonly runId: string;
      readonly message: string;
    }
  | {
      readonly type: 'end';
      readonly job: string;
      readonly runId: string;
      readonly ok: boolean;
      readonly value?: unknown;
      readonly error?: string;
      /** Platform-side execution time, seconds. */
      readonly platformTime?: number;
      readonly durationMs: number;
    };

export interface Deps {
  readonly platform: Platform;
  readonly emit: (event: RunEvent) => void;
  readonly now: () => Date;
  readonly newRunId: () => string;
  /** Required by backup jobs. */
  readonly backupSink?: (startedAt: Date) => BackupSink;
}
