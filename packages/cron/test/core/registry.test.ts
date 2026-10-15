import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { type Config, validateConfig } from '../../src/core/config.js';
import {
  checkTarget,
  distinctSchedules,
  findJob,
  jobsForSchedule,
} from '../../src/core/registry.js';

function config(jobs: Record<string, unknown>): Config {
  const result = validateConfig({ jobs });
  if (!result.ok) assert.fail(JSON.stringify(result.problems));
  return result.config;
}

const sample = config({
  digest: { schedule: '0 9 * * *' },
  prices: { schedule: '*/15 * * * *' },
  report: { schedule: '0  9 * * *' },
  off: { schedule: '0 9 * * *', enabled: false },
  backup: { schedule: '30 2 * * *', use: 'tgcloud-cron/backup' },
});

describe('registry', () => {
  test('selects enabled jobs by normalized schedule', () => {
    assert.deepEqual(
      jobsForSchedule(sample, '0 9 * * *').map((j) => j.name),
      ['digest', 'report'],
    );
    assert.deepEqual(jobsForSchedule(sample, '1 1 * * *'), []);
  });

  test('matches a schedule however its weekdays are spelled', () => {
    const c = config({ weekdays: { schedule: '0 8 * * 1-5' } });
    assert.deepEqual(
      jobsForSchedule(c, '0 8 * * MON-FRI').map((j) => j.name),
      ['weekdays'],
    );
  });

  test('lists distinct schedules of enabled jobs', () => {
    assert.deepEqual(
      distinctSchedules(sample).map((s) => s.source),
      ['0 9 * * *', '*/15 * * * *', '30 2 * * *'],
    );
  });

  test('finds a job by name, enabled or not', () => {
    assert.equal(findJob(sample, 'off')?.enabled, false);
    assert.equal(findJob(sample, 'nope'), undefined);
  });
});

describe('checkTarget', () => {
  test('github rejects schedules under 5 minutes', () => {
    const problems = checkTarget(config({ fast: { schedule: '*/2 * * * *' } }), 'github');
    assert.equal(problems.length, 1);
    assert.equal(problems[0]?.severity, 'error');
    assert.match(problems[0]?.message ?? '', /every 2 min/);
  });

  test('cloudflare allows per-minute schedules', () => {
    assert.deepEqual(checkTarget(config({ fast: { schedule: '* * * * *' } }), 'cloudflare'), []);
  });

  test('cloudflare rejects backup jobs', () => {
    const problems = checkTarget(sample, 'cloudflare');
    assert.deepEqual(
      problems.map((p) => [p.job, p.severity]),
      [['backup', 'error']],
    );
  });

  test('cloudflare warns above the free trigger limit', () => {
    const jobs = Object.fromEntries(
      [0, 1, 2, 3, 4, 5].map((h) => [`j${h}`, { schedule: `0 ${h} * * *` }]),
    );
    const problems = checkTarget(config(jobs), 'cloudflare');
    assert.equal(problems[0]?.severity, 'warning');
    assert.match(problems[0]?.message ?? '', /6 distinct schedules/);
  });

  test('warns when nothing is enabled', () => {
    assert.equal(checkTarget(config({}), 'github')[0]?.severity, 'warning');
  });
});
