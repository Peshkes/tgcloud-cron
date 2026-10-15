import type { LogEntry, Platform } from 'tgcloud-api';
import type { BackupSink } from 'tgcloud-backup';

export type { Platform };

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
  readonly backupSink?: (job: string, startedAt: Date) => BackupSink;
}
