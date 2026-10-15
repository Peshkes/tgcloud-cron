import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { type ConfigResult, type Job, validateConfig } from '../../src/core/config.js';

function ok(raw: unknown): readonly Job[] {
  const result = validateConfig(raw);
  if (!result.ok) assert.fail(JSON.stringify(result.problems));
  return result.config.jobs;
}

function problems(raw: unknown): string[] {
  const result: ConfigResult = validateConfig(raw);
  assert.equal(result.ok, false);
  return result.ok ? [] : result.problems.map((p) => `${p.path}: ${p.message}`);
}

describe('validateConfig', () => {
  test('fills defaults for a module job', () => {
    const [job] = ok({ jobs: { dailyDigest: { schedule: '0 9 * * *' } } });
    assert.deepEqual(
      { ...job, schedule: job?.schedule.source },
      {
        kind: 'module',
        name: 'dailyDigest',
        schedule: '0 9 * * *',
        enabled: true,
        module: 'lib/cron/dailyDigest',
        args: {},
      },
    );
  });

  test('accepts module, args and enabled', () => {
    const [job] = ok({
      $schema: './schema.json',
      jobs: {
        sync: { schedule: '*/15 * * * *', module: 'lib/jobs/sync', args: { a: 1 }, enabled: false },
      },
    });
    assert.equal(job?.kind, 'module');
    assert.equal(job?.kind === 'module' && job.module, 'lib/jobs/sync');
    assert.equal(job?.enabled, false);
  });

  test('fills backup defaults', () => {
    const [job] = ok({ jobs: { backup: { schedule: '30 2 * * *', use: 'tgcloud-cron/backup' } } });
    assert.equal(job?.kind, 'backup');
    if (job?.kind !== 'backup') return;
    assert.deepEqual(job.tables, []);
    assert.equal(job.pageSize, 500);
    assert.deepEqual(job.destination, { type: 'artifact', retentionDays: 30 });
  });

  test('accepts backup options', () => {
    const [job] = ok({
      jobs: {
        backup: {
          schedule: '30 2 * * *',
          use: 'tgcloud-cron/backup',
          args: { tables: ['users', 'orders'], pageSize: 200 },
          destination: { type: 'branch' },
        },
      },
    });
    if (job?.kind !== 'backup') return assert.fail('not a backup job');
    assert.deepEqual(job.tables, ['users', 'orders']);
    assert.equal(job.pageSize, 200);
    assert.deepEqual(job.destination, { type: 'branch', branch: 'tgcron-backups' });
  });

  const bad: [string, unknown, RegExp][] = [
    ['non-object root', [], /\(?\)?: must be a JSON object/],
    ['missing jobs', {}, /^jobs: must be an object/],
    ['unknown top key', { jobs: {}, job: {} }, /^job: unknown key/],
    ['bad job name', { jobs: { '1x': { schedule: '* * * * *' } } }, /^jobs\.1x: job name/],
    ['missing schedule', { jobs: { a: {} } }, /^jobs\.a\.schedule: is required/],
    [
      'bad schedule',
      { jobs: { a: { schedule: '61 * * * *' } } },
      /^jobs\.a\.schedule: minute field/,
    ],
    [
      'module with .js',
      { jobs: { a: { schedule: '0 0 * * *', module: 'lib/a.js' } } },
      /without "\.js"/,
    ],
    [
      'module with tgcloud/ prefix',
      { jobs: { a: { schedule: '0 0 * * *', module: 'tgcloud/lib/a' } } },
      /relative to tgcloud/,
    ],
    [
      'module outside lib',
      { jobs: { a: { schedule: '0 0 * * *', module: 'endpoints/a' } } },
      /under lib\//,
    ],
    ['module traversal', { jobs: { a: { schedule: '0 0 * * *', module: 'lib/../x' } } }, /segment/],
    [
      'args not object',
      { jobs: { a: { schedule: '0 0 * * *', args: [1] } } },
      /args: must be a JSON object/,
    ],
    ['enabled not boolean', { jobs: { a: { schedule: '0 0 * * *', enabled: 'no' } } }, /enabled/],
    [
      'typo in job key',
      { jobs: { a: { schedule: '0 0 * * *', schedul: 'x' } } },
      /^jobs\.a\.schedul: unknown key/,
    ],
    [
      'unknown builtin',
      { jobs: { a: { schedule: '0 0 * * *', use: 'x' } } },
      /unknown built-in job "x"/,
    ],
    [
      'bad table name',
      {
        jobs: {
          b: { schedule: '0 0 * * *', use: 'tgcloud-cron/backup', args: { tables: ['a;drop'] } },
        },
      },
      /invalid table name\(s\): "a;drop"/,
    ],
    [
      'page size too big',
      {
        jobs: {
          b: { schedule: '0 0 * * *', use: 'tgcloud-cron/backup', args: { pageSize: 99999 } },
        },
      },
      /pageSize: must be an integer/,
    ],
    [
      'retention too long',
      {
        jobs: {
          b: {
            schedule: '0 0 * * *',
            use: 'tgcloud-cron/backup',
            destination: { type: 'artifact', retentionDays: 365 },
          },
        },
      },
      /retentionDays: must be an integer from 1 to 90/,
    ],
    [
      'unknown destination',
      {
        jobs: {
          b: { schedule: '0 0 * * *', use: 'tgcloud-cron/backup', destination: { type: 's3' } },
        },
      },
      /destination\.type: must be "artifact" or "branch"/,
    ],
    [
      'module key on backup',
      { jobs: { b: { schedule: '0 0 * * *', use: 'tgcloud-cron/backup', module: 'lib/x' } } },
      /^jobs\.b\.module: unknown key/,
    ],
  ];
  for (const [name, raw, pattern] of bad) {
    test(`rejects ${name}`, () => {
      const found = problems(raw);
      assert.ok(
        found.some((p) => pattern.test(p)),
        `expected ${pattern} in:\n${found.join('\n')}`,
      );
    });
  }

  test('reports every problem at once', () => {
    const found = problems({
      jobs: { a: { schedule: 'x' }, b: { schedule: '0 0 * * *', args: 1 } },
    });
    assert.equal(found.length, 2);
  });
});
