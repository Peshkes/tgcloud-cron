import { ApiError, type Deployed } from '../adapters/tgcloud/client.js';
import {
  ENTRY_MODULE,
  entrySource,
  moduleSpace,
  type TickInfo,
} from '../adapters/tgcloud/entry.js';
import type { Config, Job } from '../core/config.js';
import { jobsForSchedule } from '../core/registry.js';
import { runBackup } from './backup.js';
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
 * Job failures come back as `ok: false`. Errors that will affect every job
 * (auth, network) are thrown so a tick can stop early.
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
      if (!deps.backupSink)
        throw new Error('backup jobs need a file system; run them with the CLI');
      const summary = await runBackup(job, modules, deps, base, started);
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
    const sources = moduleSpace(modules, { [ENTRY_MODULE]: entrySource(job.module) });
    const result = await deps.platform.run(ENTRY_MODULE, sources, { args: job.args, tick });
    for (const entry of result.logs) deps.emit({ type: 'log', ...base, entry });
    const time = result.time !== undefined ? { platformTime: result.time } : {};
    return result.ok
      ? finish(true, { value: result.value, ...time })
      : finish(false, { error: result.error, ...time });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const outcome = finish(false, { error });
    if (err instanceof ApiError && err.kind !== 'request') throw err;
    return outcome;
  }
}

export interface TickResult {
  readonly expression: string;
  readonly outcomes: readonly JobOutcome[];
  /** Set when the tick stopped early on an error that affects every job. */
  readonly fatal?: ApiError;
}

/**
 * Runs every enabled job whose schedule is `expression`, one after another.
 * Sequential on purpose: the management API starts answering 429 at about 16
 * parallel calls, and jobs on one schedule rarely need to overlap.
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

  try {
    const deployed = await deps.platform.getDeployed();
    for (const job of jobs) {
      outcomes.push(await runJob(job, deps, { deployed, scheduledAt }));
    }
  } catch (err) {
    if (err instanceof ApiError) return { expression, outcomes, fatal: err };
    throw err;
  }
  return { expression, outcomes };
}
