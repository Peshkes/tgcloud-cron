import { ApiError, type Deployed, withModules } from 'tgcloud-api';
import { runBackup } from 'tgcloud-backup';
import { ENTRY_MODULE, entrySource, type TickInfo } from '../adapters/entry.js';
import type { Config, Job } from '../core/config.js';
import { jobsForSchedule } from '../core/registry.js';
import type { Deps } from './ports.js';

export interface JobOutcome {
  readonly job: string;
  readonly runId: string;
  readonly ok: boolean;
  readonly error?: ApiError | Error;
}

export interface RunOptions {
  /** Module sources to run instead of the deployed ones (`run --local`). */
  readonly localModules?: Readonly<Record<string, string>>;
  readonly scheduledAt?: Date | null;
  /** Deployed state already fetched for this tick. */
  readonly deployed?: Deployed;
}

/**
 * Runs one job on the platform and reports it through `deps.emit`.
 *
 * Every failure of the job itself comes back as `ok: false` with the error,
 * including API errors during its `/run`. Only fetching the deployed code,
 * which happens before the job starts, can throw.
 */
export async function runJob(job: Job, deps: Deps, options: RunOptions = {}): Promise<JobOutcome> {
  const runId = deps.newRunId();
  const started = deps.now();
  const base = { job: job.name, runId };

  let deployed = options.deployed;
  if (!options.localModules && !deployed) deployed = await deps.platform.getDeployed();
  const modules = options.localModules ?? deployed?.modules ?? {};

  deps.emit({
    type: 'start',
    ...base,
    scheduledAt: options.scheduledAt ? options.scheduledAt.toISOString() : null,
    code: options.localModules ? 'local' : 'deployed',
    ...(deployed && !options.localModules ? { revision: deployed.revision } : {}),
  });

  const finish = (
    ok: boolean,
    extra: { value?: unknown; error?: Error; platformTime?: number },
  ) => {
    deps.emit({
      type: 'end',
      ...base,
      ok,
      ...(extra.value !== undefined ? { value: extra.value } : {}),
      ...(extra.error ? { error: extra.error.message } : {}),
      ...(extra.platformTime !== undefined ? { platformTime: extra.platformTime } : {}),
      durationMs: deps.now().getTime() - started.getTime(),
    });
    return { ...base, ok, ...(extra.error ? { error: extra.error } : {}) };
  };

  try {
    if (job.kind === 'backup') {
      if (!deps.backupSink) {
        throw new Error('backup jobs need a file system; run them with the CLI');
      }
      const summary = await runBackup({
        platform: deps.platform,
        sink: deps.backupSink(job.name, started),
        modules,
        tables: job.tables,
        pageSize: job.pageSize,
        now: deps.now,
        onProgress: (message) => deps.emit({ type: 'progress', ...base, message }),
      });
      return finish(true, { value: summary });
    }

    if (!(job.module in modules)) {
      const where = options.localModules
        ? 'in tgcloud/'
        : 'in the deployed code; run `tgcloud push`';
      return finish(false, { error: new Error(`module ${job.module} not found ${where}`) });
    }

    const tick: TickInfo = {
      job: job.name,
      runId,
      scheduledAt: options.scheduledAt ? options.scheduledAt.toISOString() : null,
    };
    const sources = withModules(modules, { [ENTRY_MODULE]: entrySource(job.module) });
    const result = await deps.platform.run(ENTRY_MODULE, sources, { args: job.args, tick });
    for (const entry of result.logs) deps.emit({ type: 'log', ...base, entry });
    const time = result.time !== undefined ? { platformTime: result.time } : {};
    return result.ok
      ? finish(true, { value: result.value, ...time })
      : finish(false, { error: result.error, ...time });
  } catch (err) {
    return finish(false, { error: err instanceof Error ? err : new Error(String(err)) });
  }
}

export interface TickResult {
  readonly expression: string;
  readonly outcomes: readonly JobOutcome[];
  /**
   * Set when the tick stopped early because of an error every remaining job
   * would hit: the token was rejected, or the deployed code could not be read.
   */
  readonly fatal?: ApiError;
}

/**
 * Runs every enabled job whose schedule is `expression`, one after another.
 * Sequential on purpose: the management API starts answering 429 at about 16
 * parallel calls, and jobs on one schedule rarely need to overlap. A failed
 * job does not stop the next one, except when the token is rejected.
 */
export async function runTick(
  config: Config,
  expression: string,
  deps: Deps,
  scheduledAt: Date | null,
): Promise<TickResult> {
  const jobs = jobsForSchedule(config, expression);
  const outcomes: JobOutcome[] = [];
  if (jobs.length === 0) return { expression, outcomes };

  let deployed: Deployed;
  try {
    deployed = await deps.platform.getDeployed();
  } catch (err) {
    if (err instanceof ApiError) return { expression, outcomes, fatal: err };
    throw err;
  }
  for (const job of jobs) {
    const outcome = await runJob(job, deps, { deployed, scheduledAt });
    outcomes.push(outcome);
    if (outcome.error instanceof ApiError && outcome.error.kind === 'auth') {
      return { expression, outcomes, fatal: outcome.error };
    }
  }
  return { expression, outcomes };
}
