/**
 * Five-field cron expressions, in the subset accepted by both GitHub Actions
 * and Cloudflare Cron Triggers. All times are UTC.
 */

export interface CronExpression {
  /** The expression with fields separated by single spaces. */
  readonly source: string;
  readonly minutes: readonly number[];
  readonly hours: readonly number[];
  readonly daysOfMonth: readonly number[];
  readonly months: readonly number[];
  /** 0 is Sunday. A 7 in the source is stored as 0. */
  readonly daysOfWeek: readonly number[];
  /** True when the day-of-month field starts with `*`. */
  readonly anyDayOfMonth: boolean;
  /** True when the day-of-week field starts with `*`. */
  readonly anyDayOfWeek: boolean;
}

export class CronSyntaxError extends Error {
  override readonly name = 'CronSyntaxError';
  constructor(
    readonly expression: string,
    readonly reason: string,
  ) {
    super(`Invalid cron expression "${expression}": ${reason}`);
  }
}

interface FieldSpec {
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly names?: readonly string[];
}

const MONTH_NAMES = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
] as const;
const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;

const FIELDS: readonly FieldSpec[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTH_NAMES },
  { name: 'day of week', min: 0, max: 7, names: DAY_NAMES },
];

export function parseCron(expression: string): CronExpression {
  const trimmed = expression.trim();
  if (trimmed.startsWith('@')) {
    throw new CronSyntaxError(
      expression,
      'macros such as @daily are not supported; use five fields',
    );
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    throw new CronSyntaxError(
      expression,
      `expected 5 fields (minute hour day-of-month month day-of-week), got ${trimmed ? parts.length : 0}`,
    );
  }

  const values = parts.map((part, i) => parseField(expression, part, FIELDS[i] as FieldSpec));
  const [minutes, hours, daysOfMonth, months, rawDaysOfWeek] = values as [
    number[],
    number[],
    number[],
    number[],
    number[],
  ];
  const daysOfWeek = [...new Set(rawDaysOfWeek.map((d) => (d === 7 ? 0 : d)))].sort(
    (a, b) => a - b,
  );

  return {
    source: parts.join(' '),
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    anyDayOfMonth: (parts[2] as string).startsWith('*'),
    anyDayOfWeek: (parts[4] as string).startsWith('*'),
  };
}

function parseField(expression: string, text: string, spec: FieldSpec): number[] {
  const fail = (reason: string): never => {
    throw new CronSyntaxError(expression, `${spec.name} field "${text}": ${reason}`);
  };
  const out = new Set<number>();

  for (const item of text.split(',')) {
    if (item === '') fail('empty list item');
    const [rangePart, stepPart, extra] = item.split('/');
    if (extra !== undefined) fail('more than one "/"');

    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart)) fail(`step "${stepPart}" is not a number`);
      step = Number(stepPart);
      if (step < 1) fail('step must be at least 1');
    }

    let from: number;
    let to: number;
    if (rangePart === '*') {
      // `*/2` in the weekday field means different days on different crons
      // (Cloudflare counts 1-7 from Sunday), and it changes how the two day
      // fields combine. Listing the days says the same without ambiguity.
      if (stepPart !== undefined && spec.name === 'day of week') {
        fail(
          'a step over all weekdays is ambiguous; list the days instead, e.g. "SUN,TUE,THU,SAT"',
        );
      }
      from = spec.min;
      to = spec.name === 'day of week' ? 6 : spec.max;
    } else if (rangePart?.includes('-')) {
      const [a, b, more] = rangePart.split('-');
      if (more !== undefined) fail('malformed range');
      from = parseValue(a ?? '', spec, fail);
      to = parseValue(b ?? '', spec, fail);
      if (from > to) fail(`range ${from}-${to} is reversed`);
    } else {
      from = parseValue(rangePart ?? '', spec, fail);
      to = from;
      // `5/10` means "5 to max, every 10" in some crons and is rejected in
      // others. Requiring an explicit range keeps both targets in agreement.
      if (stepPart !== undefined)
        fail(`write a range before the step, e.g. "${from}-${spec.max}/${step}"`);
    }

    for (let v = from; v <= to; v += step) out.add(v);
  }

  return [...out].sort((a, b) => a - b);
}

function parseValue(text: string, spec: FieldSpec, fail: (reason: string) => never): number {
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    if (n < spec.min || n > spec.max) fail(`${n} is outside ${spec.min}-${spec.max}`);
    return n;
  }
  if (spec.names) {
    const i = spec.names.indexOf(text.toUpperCase());
    if (i !== -1) return i + spec.min;
  }
  return fail(text === '' ? 'missing value' : `"${text}" is not a valid value`);
}

export type Dialect = 'github' | 'cloudflare';

/**
 * The expression as a target expects it. Only the weekday field differs:
 * GitHub reads 0-6 from Sunday, Cloudflare reads 1-7 from Sunday, so the
 * days are written as numbers for one and as names for the other.
 */
export function formatCron(cron: CronExpression, dialect: Dialect): string {
  const fields = cron.source.split(' ');
  if (fields[4] !== '*') fields[4] = formatWeekdays(cron.daysOfWeek, dialect);
  return fields.join(' ');
}

function formatWeekdays(days: readonly number[], dialect: Dialect): string {
  const name = (d: number) => (dialect === 'cloudflare' ? (DAY_NAMES[d] as string) : String(d));
  const parts: string[] = [];
  for (let i = 0; i < days.length; ) {
    let j = i;
    while (j + 1 < days.length && (days[j + 1] as number) === (days[j] as number) + 1) j++;
    const from = days[i] as number;
    const to = days[j] as number;
    if (to - from >= 2) parts.push(`${name(from)}-${name(to)}`);
    else for (let d = from; d <= to; d++) parts.push(name(d));
    i = j + 1;
  }
  return parts.join(',');
}

/**
 * Identifies what an expression means rather than how it is written, so
 * `0 9 * * 1-5`, `0 9 * * MON-FRI` and `0 9 * * mon,tue,wed,thu,fri` match.
 */
export function scheduleKey(cron: CronExpression): string {
  return [
    cron.minutes,
    cron.hours,
    cron.daysOfMonth,
    cron.months,
    cron.daysOfWeek,
    cron.anyDayOfMonth,
    cron.anyDayOfWeek,
  ]
    .map(String)
    .join('|');
}

export function matches(cron: CronExpression, date: Date): boolean {
  return (
    cron.minutes.includes(date.getUTCMinutes()) &&
    cron.hours.includes(date.getUTCHours()) &&
    cron.months.includes(date.getUTCMonth() + 1) &&
    dayMatches(cron, date)
  );
}

// Vixie cron rule: when both day fields are restricted, a day matches if
// either field matches; otherwise both must match.
function dayMatches(cron: CronExpression, date: Date): boolean {
  const dom = cron.daysOfMonth.includes(date.getUTCDate());
  const dow = cron.daysOfWeek.includes(date.getUTCDay());
  if (!cron.anyDayOfMonth && !cron.anyDayOfWeek) return dom || dow;
  return dom && dow;
}

const MINUTE = 60_000;
// The rarest firing expression is February 29 (every 4 years, 8 across a
// skipped century leap year such as 2100). An expression that does not fire
// within 8 years never fires.
const SEARCH_LIMIT_DAYS = 366 * 8;

/**
 * The next `count` fire times strictly after `after`, in ascending order.
 * Returns fewer if the expression never fires (e.g. `0 0 30 2 *`).
 */
export function nextRuns(cron: CronExpression, after: Date, count = 1): Date[] {
  const out: Date[] = [];
  let t = new Date(Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE);
  const limit = after.getTime() + SEARCH_LIMIT_DAYS * 24 * 60 * MINUTE;

  while (out.length < count && t.getTime() <= limit) {
    if (!cron.months.includes(t.getUTCMonth() + 1)) {
      t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 1));
    } else if (!dayMatches(cron, t)) {
      t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1));
    } else if (!cron.hours.includes(t.getUTCHours())) {
      t = new Date(
        Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), t.getUTCHours() + 1),
      );
    } else if (!cron.minutes.includes(t.getUTCMinutes())) {
      t = new Date(t.getTime() + MINUTE);
    } else {
      out.push(t);
      t = new Date(t.getTime() + MINUTE);
    }
  }
  return out;
}

/**
 * The latest fire time at or before `at`, or undefined if there is none in
 * the search window. Used to label a tick whose scheduler does not report
 * the scheduled time (GitHub Actions starts runs late under load).
 */
export function previousRun(cron: CronExpression, at: Date): Date | undefined {
  let t = Math.floor(at.getTime() / MINUTE) * MINUTE;
  const limit = at.getTime() - SEARCH_LIMIT_DAYS * 24 * 60 * MINUTE;

  while (t >= limit) {
    const d = new Date(t);
    const y = d.getUTCFullYear();
    const mo = d.getUTCMonth();
    const day = d.getUTCDate();
    // Each branch jumps to the last minute of the previous month, day or hour.
    if (!cron.months.includes(mo + 1)) {
      t = Date.UTC(y, mo, 1) - MINUTE;
    } else if (!dayMatches(cron, d)) {
      t = Date.UTC(y, mo, day) - MINUTE;
    } else if (!cron.hours.includes(d.getUTCHours())) {
      t = Date.UTC(y, mo, day, d.getUTCHours()) - MINUTE;
    } else if (!cron.minutes.includes(d.getUTCMinutes())) {
      t -= MINUTE;
    } else {
      return d;
    }
  }
  return undefined;
}

/**
 * The shortest gap, in minutes, between two consecutive fire times. Used to
 * enforce the 5-minute floor of GitHub Actions. Returns Infinity for an
 * expression that fires at most once a day.
 */
export function shortestIntervalMinutes(cron: CronExpression): number {
  let best = Number.POSITIVE_INFINITY;
  const m = cron.minutes;
  for (let i = 1; i < m.length; i++) {
    best = Math.min(best, (m[i] as number) - (m[i - 1] as number));
  }
  // Gap across an hour boundary, from the last minute of one allowed hour to
  // the first minute of the next one.
  const h = new Set(cron.hours);
  const first = m[0] as number;
  const last = m[m.length - 1] as number;
  for (const hour of h) {
    if (h.has((hour + 1) % 24)) {
      best = Math.min(best, 60 - last + first);
      break;
    }
  }
  return best;
}
