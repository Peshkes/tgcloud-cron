import { type CronExpression, CronSyntaxError, parseCron } from './cron.js';

export const CONFIG_FILE = 'tgcron.json';
export const BACKUP_JOB = 'tgcloud-cron/backup';
/** Directory, relative to the project's `tgcloud/`, that jobs default to. */
export const JOB_MODULE_DIR = 'lib/cron';

export type JsonObject = { [key: string]: unknown };

export interface ModuleJob {
  readonly kind: 'module';
  readonly name: string;
  readonly schedule: CronExpression;
  readonly enabled: boolean;
  /** Module name inside `tgcloud/`, without `.js`, e.g. `lib/cron/dailyDigest`. */
  readonly module: string;
  readonly args: JsonObject;
}

export type BackupDestination =
  | { readonly type: 'artifact'; readonly retentionDays: number }
  | { readonly type: 'branch'; readonly branch: string };

export interface BackupJob {
  readonly kind: 'backup';
  readonly name: string;
  readonly schedule: CronExpression;
  readonly enabled: boolean;
  /** Tables to export. Empty means "discover from sqlite_master". */
  readonly tables: readonly string[];
  readonly pageSize: number;
  readonly destination: BackupDestination;
}

export type Job = ModuleJob | BackupJob;

export interface Config {
  readonly jobs: readonly Job[];
}

export interface ConfigProblem {
  /** JSON path of the offending value, e.g. `jobs.backup.schedule`. */
  readonly path: string;
  readonly message: string;
}

export type ConfigResult =
  | { readonly ok: true; readonly config: Config }
  | { readonly ok: false; readonly problems: readonly ConfigProblem[] };

const JOB_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MODULE_SEGMENT = /^[A-Za-z0-9_-]+$/;
const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BRANCH_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
// Backups are personal data. Pushing them to a branch that is deployed or
// published, or that holds the code, would be a leak or worse.
const RESERVED_BRANCHES = new Set(['head', 'main', 'master', 'gh-pages', 'develop', 'trunk']);

const TOP_KEYS = ['$schema', 'jobs'];
const MODULE_JOB_KEYS = ['schedule', 'enabled', 'module', 'args'];
const BACKUP_JOB_KEYS = ['schedule', 'enabled', 'use', 'args', 'destination'];

export const DEFAULT_PAGE_SIZE = 500;
export const MAX_PAGE_SIZE = 10_000;
export const DEFAULT_RETENTION_DAYS = 30;

/** Validates a parsed `tgcron.json`. Collects every problem instead of stopping at the first. */
export function validateConfig(raw: unknown): ConfigResult {
  const problems: ConfigProblem[] = [];
  const report = (path: string, message: string) => {
    problems.push({ path, message });
  };

  if (!isObject(raw)) {
    return { ok: false, problems: [{ path: '', message: 'must be a JSON object' }] };
  }
  unknownKeys(raw, TOP_KEYS, '', report);

  const jobsRaw = raw.jobs;
  if (!isObject(jobsRaw)) {
    report('jobs', 'must be an object mapping job names to job definitions');
    return { ok: false, problems };
  }

  const jobs: Job[] = [];
  for (const [name, def] of Object.entries(jobsRaw)) {
    const job = validateJob(name, def, report);
    if (job) jobs.push(job);
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, config: { jobs } };
}

function validateJob(
  name: string,
  def: unknown,
  report: (path: string, message: string) => void,
): Job | undefined {
  const at = `jobs.${name}`;
  let valid = true;
  const fail = (path: string, message: string) => {
    valid = false;
    report(path, message);
  };

  if (!JOB_NAME.test(name)) {
    fail(
      at,
      'job name must start with a letter and use only letters, digits, "_" and "-" (max 64)',
    );
  }
  if (!isObject(def)) {
    fail(at, 'must be an object with at least a "schedule"');
    return undefined;
  }

  let schedule: CronExpression | undefined;
  if (typeof def.schedule !== 'string') {
    fail(`${at}.schedule`, 'is required and must be a cron expression string');
  } else {
    try {
      schedule = parseCron(def.schedule);
    } catch (err) {
      if (!(err instanceof CronSyntaxError)) throw err;
      fail(`${at}.schedule`, err.reason);
    }
  }

  let enabled = true;
  if (def.enabled !== undefined) {
    if (typeof def.enabled !== 'boolean') fail(`${at}.enabled`, 'must be true or false');
    else enabled = def.enabled;
  }

  let args: JsonObject = {};
  if (def.args !== undefined) {
    if (!isObject(def.args)) fail(`${at}.args`, 'must be a JSON object');
    else args = def.args;
  }

  if (def.use !== undefined) {
    if (def.use !== BACKUP_JOB) {
      fail(`${at}.use`, `unknown built-in job "${String(def.use)}"; available: ${BACKUP_JOB}`);
      return undefined;
    }
    unknownKeys(def, BACKUP_JOB_KEYS, at, fail);
    const tables = backupTables(args.tables, `${at}.args.tables`, fail);
    const pageSize = backupPageSize(args.pageSize, `${at}.args.pageSize`, fail);
    unknownKeys(args, ['tables', 'pageSize'], `${at}.args`, fail);
    const destination = backupDestination(def.destination, `${at}.destination`, fail);
    if (!valid || !schedule || !destination) return undefined;
    return { kind: 'backup', name, schedule, enabled, tables, pageSize, destination };
  }

  unknownKeys(def, MODULE_JOB_KEYS, at, fail);
  let module = `${JOB_MODULE_DIR}/${name}`;
  if (def.module !== undefined) {
    const problem = typeof def.module === 'string' ? moduleProblem(def.module) : 'must be a string';
    if (problem) fail(`${at}.module`, problem);
    else module = def.module as string;
  }

  if (!valid || !schedule) return undefined;
  return { kind: 'module', name, schedule, enabled, module, args };
}

function moduleProblem(module: string): string | undefined {
  if (module.endsWith('.js')) {
    return `use the module name without ".js", e.g. "${module.slice(0, -3)}"`;
  }
  if (module.startsWith('tgcloud/')) {
    return `module names are relative to tgcloud/, e.g. "${module.slice('tgcloud/'.length)}"`;
  }
  const segments = module.split('/');
  if (segments[0] !== 'lib' || segments.length < 2) {
    // handlers/ and endpoints/ are reachable by Telegram updates or Mini App
    // users; a job module there would run outside the schedule too.
    return 'must be a module under lib/, e.g. "lib/cron/dailyDigest"';
  }
  if (!segments.every((s) => MODULE_SEGMENT.test(s))) {
    return 'each path segment may use only letters, digits, "_" and "-"';
  }
  return undefined;
}

function backupTables(
  value: unknown,
  path: string,
  fail: (path: string, message: string) => void,
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0) {
    fail(path, 'must be a non-empty array of table names, or omitted to export every table');
    return [];
  }
  const bad = value.filter((t) => typeof t !== 'string' || !SQL_IDENTIFIER.test(t));
  if (bad.length > 0) {
    fail(path, `invalid table name(s): ${bad.map((t) => JSON.stringify(t)).join(', ')}`);
  }
  return value as string[];
}

function backupPageSize(
  value: unknown,
  path: string,
  fail: (path: string, message: string) => void,
): number {
  if (value === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_PAGE_SIZE) {
    fail(path, `must be an integer from 1 to ${MAX_PAGE_SIZE}`);
    return DEFAULT_PAGE_SIZE;
  }
  return value as number;
}

function backupDestination(
  value: unknown,
  path: string,
  fail: (path: string, message: string) => void,
): BackupDestination | undefined {
  if (value === undefined) return { type: 'artifact', retentionDays: DEFAULT_RETENTION_DAYS };
  if (!isObject(value)) {
    fail(path, 'must be an object, e.g. { "type": "artifact" } or { "type": "branch" }');
    return undefined;
  }
  if (value.type === 'artifact') {
    unknownKeys(value, ['type', 'retentionDays'], path, fail);
    const days = value.retentionDays ?? DEFAULT_RETENTION_DAYS;
    // GitHub accepts 1-90 days for artifact retention.
    if (!Number.isInteger(days) || (days as number) < 1 || (days as number) > 90) {
      fail(`${path}.retentionDays`, 'must be an integer from 1 to 90');
      return undefined;
    }
    return { type: 'artifact', retentionDays: days as number };
  }
  if (value.type === 'branch') {
    unknownKeys(value, ['type', 'branch'], path, fail);
    const branch = value.branch ?? 'tgcron-backups';
    if (typeof branch !== 'string') {
      fail(`${path}.branch`, 'must be a string');
      return undefined;
    }
    const problem = branchProblem(branch);
    if (problem) {
      fail(`${path}.branch`, problem);
      return undefined;
    }
    return { type: 'branch', branch };
  }
  fail(`${path}.type`, 'must be "artifact" or "branch"');
  return undefined;
}

/** Git ref rules that matter here, stricter than `git check-ref-format`. */
function branchProblem(branch: string): string | undefined {
  if (branch.length > 100) return 'must be at most 100 characters';
  const segments = branch.split('/');
  const valid = segments.every(
    (s) => BRANCH_SEGMENT.test(s) && !s.endsWith('.') && !s.endsWith('.lock') && !s.includes('..'),
  );
  if (!valid) {
    return 'must be a git branch name of letters, digits, ".", "_", "-" and "/", not starting with "-" or "."';
  }
  if (RESERVED_BRANCHES.has(branch.toLowerCase())) {
    return `"${branch}" holds code or is published; use a branch only for backups, e.g. "tgcron-backups"`;
  }
  return undefined;
}

function unknownKeys(
  obj: JsonObject,
  allowed: readonly string[],
  at: string,
  report: (path: string, message: string) => void,
) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      report(at ? `${at}.${key}` : key, `unknown key; expected one of: ${allowed.join(', ')}`);
    }
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function formatProblems(problems: readonly ConfigProblem[]): string {
  return problems.map((p) => `  ${p.path || '(root)'}: ${p.message}`).join('\n');
}
