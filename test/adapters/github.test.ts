import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { generateGithubWorkflow } from '../../src/adapters/github/workflow.js';
import { type Config, validateConfig } from '../../src/core/config.js';
import { assertGolden } from '../helpers/golden.js';

function config(jobs: Record<string, unknown>): Config {
  const r = validateConfig({ jobs });
  if (!r.ok) assert.fail(JSON.stringify(r.problems));
  return r.config;
}

const options = { version: '0.1.0' };

describe('generateGithubWorkflow', () => {
  test('module jobs only', () => {
    const yaml = generateGithubWorkflow(
      config({
        dailyDigest: { schedule: '0 9 * * *' },
        syncPrices: { schedule: '*/15 * * * *' },
        weeklyReport: { schedule: '0  9 * * *' },
        paused: { schedule: '0 3 * * *', enabled: false },
      }),
      options,
    );
    assertGolden('github-modules.yml', yaml);
    assert.equal(yaml.match(/- cron:/g)?.length, 2, 'one entry per distinct schedule');
    assert.doesNotMatch(yaml, /paused/);
    assert.match(yaml, /contents: read/);
    assert.doesNotMatch(yaml, /run: .*\$\{\{/, 'expressions reach scripts through env only');
  });

  test('backup to an artifact', () => {
    const yaml = generateGithubWorkflow(
      config({
        backup: {
          schedule: '30 2 * * *',
          use: 'tgcloud-cron/backup',
          destination: { type: 'artifact', retentionDays: 14 },
        },
      }),
      options,
    );
    assertGolden('github-backup-artifact.yml', yaml);
    assert.match(yaml, /retention-days: 14/);
  });

  test('backup to a branch asks for write access', () => {
    const yaml = generateGithubWorkflow(
      config({
        backup: {
          schedule: '30 2 * * *',
          use: 'tgcloud-cron/backup',
          destination: { type: 'branch' },
        },
      }),
      options,
    );
    assertGolden('github-backup-branch.yml', yaml);
    assert.match(yaml, /contents: write/);
    assert.match(yaml, /branch='tgcron-backups'/);
  });

  test('no jobs still produces a valid manual trigger', () => {
    const yaml = generateGithubWorkflow(config({}), options);
    assert.doesNotMatch(yaml, /schedule:\n/);
    assert.match(yaml, /type: string/);
  });

  test('pins the version', () => {
    const yaml = generateGithubWorkflow(config({ a: { schedule: '0 0 * * *' } }), {
      version: '1.2.3',
    });
    assert.equal(yaml.match(/tgcloud-cron@1\.2\.3/g)?.length, 2);
  });
});
