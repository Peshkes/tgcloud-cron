import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CronSyntaxError,
  matches,
  nextRuns,
  parseCron,
  previousRun,
  shortestIntervalMinutes,
} from '../../src/core/cron.js';

const iso = (dates: Date[]) => dates.map((d) => d.toISOString());

describe('parseCron', () => {
  const valid: [string, Partial<Record<string, number[]>>][] = [
    ['* * * * *', { hours: range(0, 23), daysOfWeek: range(0, 6) }],
    ['0 9 * * *', { minutes: [0], hours: [9] }],
    ['*/15 * * * *', { minutes: [0, 15, 30, 45] }],
    ['0-30/10 * * * *', { minutes: [0, 10, 20, 30] }],
    ['5,1,3 * * * *', { minutes: [1, 3, 5] }],
    ['0 0 1 jan,Jul *', { months: [1, 7] }],
    ['0 0 * * MON-FRI', { daysOfWeek: [1, 2, 3, 4, 5] }],
    ['0 0 * * 5-7', { daysOfWeek: [0, 5, 6] }],
    ['0 0 * * 7', { daysOfWeek: [0] }],
    ['0 0 * * */2', { daysOfWeek: [0, 2, 4, 6] }],
    ['  0   9  *  *  * ', { minutes: [0], hours: [9] }],
  ];
  for (const [expr, expected] of valid) {
    test(`accepts "${expr}"`, () => {
      const cron = parseCron(expr);
      for (const [key, value] of Object.entries(expected)) {
        assert.deepEqual(cron[key as keyof typeof cron], value, key);
      }
    });
  }

  test('normalizes whitespace in source', () => {
    assert.equal(parseCron('  0   9  *  *  * ').source, '0 9 * * *');
  });

  test('records whether day fields start with *', () => {
    const c = parseCron('0 0 */2 * MON');
    assert.equal(c.anyDayOfMonth, true);
    assert.equal(c.anyDayOfWeek, false);
  });

  const invalid: [string, RegExp][] = [
    ['', /expected 5 fields.*got 0/],
    ['* * * *', /expected 5 fields.*got 4/],
    ['* * * * * *', /got 6/],
    ['@daily', /macros/],
    ['60 * * * *', /minute field "60": 60 is outside 0-59/],
    ['* 24 * * *', /hour field/],
    ['* * 0 * *', /day of month field/],
    ['* * * 13 *', /month field/],
    ['* * * * 8', /day of week field/],
    ['5/10 * * * *', /write a range before the step, e.g. "5-59\/10"/],
    ['*/0 * * * *', /step must be at least 1/],
    ['*/x * * * *', /step "x" is not a number/],
    ['30-10 * * * *', /reversed/],
    ['1,,2 * * * *', /empty list item/],
    ['* * * * L', /"L" is not a valid value/],
    ['* * ? * *', /"\?" is not a valid value/],
    ['* * * * 5#3', /not a valid value/],
    ['1-2-3 * * * *', /malformed range/],
    ['*/5/2 * * * *', /more than one/],
    ['- * * * *', /missing value/],
  ];
  for (const [expr, message] of invalid) {
    test(`rejects "${expr}"`, () => {
      assert.throws(
        () => parseCron(expr),
        (err: unknown) => err instanceof CronSyntaxError && message.test(err.message),
      );
    });
  }
});

describe('matches', () => {
  test('applies the OR rule when both day fields are restricted', () => {
    const c = parseCron('0 0 13 * FRI');
    assert.equal(matches(c, new Date('2026-10-13T00:00:00Z')), true); // Tuesday the 13th
    assert.equal(matches(c, new Date('2026-10-16T00:00:00Z')), true); // Friday
    assert.equal(matches(c, new Date('2026-10-14T00:00:00Z')), false);
  });

  test('applies the AND rule when a day field starts with *', () => {
    const c = parseCron('0 0 */2 * FRI');
    assert.equal(matches(c, new Date('2026-10-16T00:00:00Z')), false); // Friday the 16th
    assert.equal(matches(c, new Date('2026-10-23T00:00:00Z')), true); // Friday the 23rd
  });
});

describe('nextRuns', () => {
  test('returns times strictly after the start, in UTC', () => {
    const from = new Date('2026-10-15T09:00:00Z');
    assert.deepEqual(iso(nextRuns(parseCron('0 9 * * *'), from, 2)), [
      '2026-10-16T09:00:00.000Z',
      '2026-10-17T09:00:00.000Z',
    ]);
  });

  test('ignores seconds in the start time', () => {
    const from = new Date('2026-10-15T09:14:59.900Z');
    assert.deepEqual(iso(nextRuns(parseCron('*/15 * * * *'), from, 3)), [
      '2026-10-15T09:15:00.000Z',
      '2026-10-15T09:30:00.000Z',
      '2026-10-15T09:45:00.000Z',
    ]);
  });

  test('crosses month and year boundaries', () => {
    const from = new Date('2026-12-31T23:59:00Z');
    assert.deepEqual(iso(nextRuns(parseCron('30 2 1 * *'), from, 2)), [
      '2027-01-01T02:30:00.000Z',
      '2027-02-01T02:30:00.000Z',
    ]);
  });

  test('finds February 29', () => {
    const from = new Date('2026-10-15T00:00:00Z');
    assert.deepEqual(iso(nextRuns(parseCron('0 0 29 2 *'), from)), ['2028-02-29T00:00:00.000Z']);
  });

  test('returns nothing for an impossible date', () => {
    assert.deepEqual(nextRuns(parseCron('0 0 30 2 *'), new Date('2026-01-01T00:00:00Z'), 1), []);
  });

  test('handles weekday names', () => {
    const from = new Date('2026-10-15T12:00:00Z'); // Thursday
    assert.deepEqual(iso(nextRuns(parseCron('0 8 * * MON-FRI'), from, 3)), [
      '2026-10-16T08:00:00.000Z',
      '2026-10-19T08:00:00.000Z',
      '2026-10-20T08:00:00.000Z',
    ]);
  });
});

describe('previousRun', () => {
  const cases: [string, string, string | undefined][] = [
    ['0 9 * * *', '2026-10-16T09:00:00Z', '2026-10-16T09:00:00.000Z'],
    ['0 9 * * *', '2026-10-16T09:47:31Z', '2026-10-16T09:00:00.000Z'],
    ['0 9 * * *', '2026-10-16T08:59:00Z', '2026-10-15T09:00:00.000Z'],
    ['*/15 * * * *', '2026-10-16T10:14:00Z', '2026-10-16T10:00:00.000Z'],
    ['30 2 1 * *', '2026-01-01T00:00:00Z', '2025-12-01T02:30:00.000Z'],
    ['0 0 29 2 *', '2027-01-01T00:00:00Z', '2024-02-29T00:00:00.000Z'],
    ['0 0 * * MON', '2026-10-15T12:00:00Z', '2026-10-12T00:00:00.000Z'],
    ['0 0 30 2 *', '2026-10-15T12:00:00Z', undefined],
  ];
  for (const [expr, at, expected] of cases) {
    test(`"${expr}" at ${at}`, () => {
      assert.equal(previousRun(parseCron(expr), new Date(at))?.toISOString(), expected);
    });
  }
});

describe('shortestIntervalMinutes', () => {
  const cases: [string, number][] = [
    ['* * * * *', 1],
    ['*/5 * * * *', 5],
    ['*/15 * * * *', 15],
    ['0,3 9 * * *', 3],
    ['58 9,10 * * *', 60],
    ['0,58 * * * *', 2], // 58 -> next hour's 0
    ['0 9 * * *', Number.POSITIVE_INFINITY],
    ['0 * * * *', 60],
  ];
  for (const [expr, expected] of cases) {
    test(`"${expr}" -> ${expected}`, () => {
      assert.equal(shortestIntervalMinutes(parseCron(expr)), expected);
    });
  }
});

function range(a: number, b: number): number[] {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}
