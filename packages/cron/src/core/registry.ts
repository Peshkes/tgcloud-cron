import type { Config, Job } from './config.js';
import { type CronExpression, parseCron, scheduleKey, shortestIntervalMinutes } from './cron.js';

export type Target = 'github' | 'cloudflare';
export const TARGETS: readonly Target[] = ['github', 'cloudflare'];

export function findJob(config: Config, name: string): Job | undefined {
  return config.jobs.find((j) => j.name === name);
}

export function enabledJobs(config: Config): Job[] {
  return config.jobs.filter((j) => j.enabled);
}

/**
 * Enabled jobs whose schedule means the same as `expression`. Schedulers
 * report the expression that fired as the generated text, which can spell
 * weekdays differently from tgcron.json.
 */
export function jobsForSchedule(config: Config, expression: string): Job[] {
  const key = scheduleKey(parseCron(expression));
  return enabledJobs(config).filter((j) => scheduleKey(j.schedule) === key);
}

/** Distinct schedules of enabled jobs, in first-seen order. */
export function distinctSchedules(config: Config): CronExpression[] {
  const seen = new Map<string, CronExpression>();
  for (const job of enabledJobs(config)) {
    const key = scheduleKey(job.schedule);
    if (!seen.has(key)) seen.set(key, job.schedule);
  }
  return [...seen.values()];
}

export interface TargetProblem {
  readonly job?: string;
  readonly severity: 'error' | 'warning';
  readonly message: string;
}

// GitHub: "The shortest interval you can run scheduled workflows is once every 5 minutes."
const GITHUB_MIN_INTERVAL = 5;
// Cloudflare Workers free plan: 5 Cron Triggers per account.
const CLOUDFLARE_FREE_TRIGGERS = 5;

/** What prevents, or degrades, running this config on a target. */
export function checkTarget(config: Config, target: Target): TargetProblem[] {
  const problems: TargetProblem[] = [];
  const jobs = enabledJobs(config);

  if (jobs.length === 0) {
    problems.push({ severity: 'warning', message: 'no enabled jobs; nothing will be scheduled' });
  }

  if (target === 'github') {
    for (const job of jobs) {
      const gap = shortestIntervalMinutes(job.schedule);
      if (gap < GITHUB_MIN_INTERVAL) {
        problems.push({
          job: job.name,
          severity: 'error',
          message: `"${job.schedule.source}" fires every ${gap} min; GitHub Actions runs schedules at most every ${GITHUB_MIN_INTERVAL} min`,
        });
      }
    }
  }

  if (target === 'cloudflare') {
    for (const job of jobs) {
      if (job.kind === 'backup') {
        problems.push({
          job: job.name,
          severity: 'error',
          message: 'backup jobs write files and are supported only on the github target',
        });
      }
    }
    const count = distinctSchedules(config).length;
    if (count > CLOUDFLARE_FREE_TRIGGERS) {
      problems.push({
        severity: 'warning',
        message: `${count} distinct schedules; the Workers free plan allows ${CLOUDFLARE_FREE_TRIGGERS} Cron Triggers per account`,
      });
    }
  }

  return problems;
}
